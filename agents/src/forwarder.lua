-- Runs inside a child agent's Neovim, sent there by `agents` with
-- nvim_exec_lua. Forwards the child's cc.nvim state to the parent agent that
-- owns it. Needs nothing from cc.nvim but `User CcStateChanged` (data.bufnr,
-- data.state) and `list_instances()`, so it works on cc.nvim versions with no
-- delegation code. Self-contained: no file on disk, no module.
--
-- Globals in the child's Neovim:
--   cc_delegation_forwarders[name] = { name, parent = { key, socket, bufnr,
--     session_id }, child_bufnr, child_key }  (the registry the inventory reads)
--   cc_delegation_seq       one counter for every push from this Neovim
--   cc_delegation_channels  socket path -> rpc channel
--   cc_delegation_repush(parent_key)  push every child of that parent again
--
-- Ops (the argument's `op`):
--   install    { parent, child_bufnr, child_key }: install the autocmd, then
--              read the child's current state and push it once, so a change
--              between open and install is covered. Idempotent.
--   uninstall  { child_bufnr, parent_key? }: remove the forwarders for that
--              child (only the one to parent_key when given).
--   repush     { parent_key? }: push current state for that parent's
--              children, or every child.
local a = ...

local R = _G.cc_delegation_forwarders or {}
_G.cc_delegation_forwarders = R
local channels = _G.cc_delegation_channels or {}
_G.cc_delegation_channels = channels

local RECEIVE = "local ok, D = pcall(require, 'cc.delegation') if ok and type(D._remote) == 'function' then D._remote('receive', ...) end"

local function notify(socket, code, args)
  for _ = 1, 2 do
    local chan = channels[socket]
    if not chan then
      local ok, c = pcall(vim.fn.sockconnect, 'pipe', socket, { rpc = true })
      if not ok or type(c) ~= 'number' or c <= 0 then return false end
      chan = c
      channels[socket] = c
    end
    if pcall(vim.rpcnotify, chan, 'nvim_exec_lua', code, args) then return true end
    -- The cached channel was closed by the peer: reconnect once.
    channels[socket] = nil
    pcall(vim.fn.chanclose, chan)
  end
  return false
end

local function snapshot(bufnr)
  local ok, list = pcall(function() return require('cc').list_instances() end)
  if ok and type(list) == 'table' then
    for _, s in ipairs(list) do
      if s.outputBufnr == bufnr then return s end
    end
  end
  return nil
end

local function push(entry, state, session_id)
  _G.cc_delegation_seq = (_G.cc_delegation_seq or 0) + 1
  return notify(entry.parent.socket, RECEIVE, { {
    parent_bufnr = entry.parent.bufnr,
    parent_session_id = entry.parent.session_id,
    key = entry.child_key,
    session_id = session_id,
    state = state,
    seq = _G.cc_delegation_seq,
  } })
end

local function push_current(entry)
  local s = snapshot(entry.child_bufnr)
  -- No instance at that buffer: the child closed (older cc.nvim fires no
  -- event for that). The parent drops it.
  return push(entry, s and s.state or 'exited', s and s.sessionId ~= vim.NIL and s.sessionId or nil)
end

function _G.cc_delegation_repush(parent_key)
  for _, entry in pairs(R) do
    if parent_key == nil or entry.parent.key == parent_key then push_current(entry) end
  end
end

local function uninstall(name)
  pcall(vim.api.nvim_del_augroup_by_name, name)
  R[name] = nil
end

if a.op == 'repush' then
  _G.cc_delegation_repush(a.parent_key)
  return { ok = true }
end

if a.op == 'uninstall' then
  local removed = 0
  for name, entry in pairs(R) do
    if entry.child_bufnr == a.child_bufnr and (a.parent_key == nil or entry.parent.key == a.parent_key) then
      uninstall(name)
      removed = removed + 1
    end
  end
  return { ok = true, removed = removed }
end

if a.op ~= 'install' then return { err = 'unknown forwarder op ' .. tostring(a.op) } end

if not pcall(require, 'cc.state_events') then
  return { err = "the child's cc.nvim has no CcStateChanged event" }
end
if not snapshot(a.child_bufnr) then
  return { err = 'no cc.nvim instance owns buffer ' .. tostring(a.child_bufnr) }
end

local parent = a.parent
local name = ('cc_delegation_%s_%d_%d'):format(parent.socket, parent.bufnr, a.child_bufnr):gsub('[^%w_]', '_')
-- One parent per child: drop forwarders to any other parent.
for other, entry in pairs(R) do
  if entry.child_bufnr == a.child_bufnr and other ~= name then uninstall(other) end
end
local entry = {
  name = name,
  parent = {
    key = parent.key, socket = parent.socket, bufnr = parent.bufnr,
    session_id = parent.session_id ~= vim.NIL and parent.session_id or nil,
  },
  child_bufnr = a.child_bufnr,
  child_key = a.child_key,
}
R[name] = entry
vim.api.nvim_create_autocmd('User', {
  group = vim.api.nvim_create_augroup(name, { clear = true }),
  pattern = 'CcStateChanged',
  callback = function(ev)
    local d = ev.data
    if type(d) ~= 'table' or d.bufnr ~= entry.child_bufnr then return end
    if R[name] ~= entry then return true end -- replaced or removed: drop this autocmd
    push(entry, d.state)
    if d.state == 'exited' and d.closed then uninstall(name) end
  end,
})
push_current(entry)
return { ok = true }
