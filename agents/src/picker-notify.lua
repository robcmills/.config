-- Tells open `agents -i` popups that an agent changed, so they reload without
-- polling, and tells a waiting `jarvis spawn` its Worker's name. Loaded once
-- per Neovim from nvim/init.lua.
--
-- On cc.nvim's `User CcStateChanged` (any state change, an instance opening,
-- closing, or its Neovim exiting) or `User CcRenamed`, connect to every popup
-- socket (`<pid>.sock`) in the picker directory and hang up: the connection
-- is the message. On `CcRenamed`, also write one JSON line
-- `{"key","name","transient"}` to every `spawn-<pid>.sock` there. A Neovim
-- with no cc.nvim instance never fires either event; with nothing listening,
-- the cost is one scandir of an empty or missing directory.
--
-- The directory must match pickerDir() in picker.ts.
local dir = vim.env.AGENTS_PICKER_DIR
if not dir or dir == '' then dir = '/tmp/agents-picker.' .. (vim.env.USER or 'unknown') end

local uv = vim.uv

--- Write `payload` to a socket and close it, without blocking. Failures (a
--- dead spawn's leftover socket) are ignored.
local function send(path, payload)
  local pipe = uv.new_pipe(false)
  if not pipe then return end
  pipe:connect(path, function(err)
    if err then return pipe:close() end
    pipe:write(payload, function()
      pipe:shutdown(function() pipe:close() end)
    end)
  end)
end

local function notify(ev)
  local handle = uv.fs_scandir(dir)
  if not handle then return end
  local rename
  if ev.match == 'CcRenamed' and type(ev.data) == 'table' and ev.data.bufnr then
    rename = vim.json.encode({
      key = vim.fn.getpid() .. ':' .. ev.data.bufnr,
      name = ev.data.name or vim.NIL,
      transient = ev.data.transient == true,
    }) .. '\n'
  end
  while true do
    local name = uv.fs_scandir_next(handle)
    if not name then return end
    if name:match('^%d+%.sock$') then
      -- Synchronous connect, so the poke lands even from VimLeavePre. A dead
      -- popup's leftover socket refuses at once.
      local ok, chan = pcall(vim.fn.sockconnect, 'pipe', dir .. '/' .. name, { rpc = false })
      if ok and type(chan) == 'number' and chan > 0 then pcall(vim.fn.chanclose, chan) end
    elseif rename and name:match('^spawn%-%d+%.sock$') then
      send(dir .. '/' .. name, rename)
    end
  end
end

vim.api.nvim_create_autocmd('User', {
  group = vim.api.nvim_create_augroup('agents_picker_notify', { clear = true }),
  pattern = { 'CcStateChanged', 'CcRenamed' },
  callback = notify,
})
