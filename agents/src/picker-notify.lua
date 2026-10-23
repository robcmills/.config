-- Tells open `agents -i` popups that an agent changed, so they reload without
-- polling. Loaded once per Neovim from nvim/init.lua. On cc.nvim's
-- `User CcStateChanged` (any state change, an instance opening, closing, or
-- its Neovim exiting), connect to every popup socket in the picker directory
-- and hang up: the connection is the message. A Neovim with no cc.nvim
-- instance never fires the event; with no popup open, the cost is one
-- scandir of an empty or missing directory.
--
-- The directory must match pickerDir() in picker.ts.
local dir = vim.env.AGENTS_PICKER_DIR
if not dir or dir == '' then dir = '/tmp/agents-picker.' .. (vim.env.USER or 'unknown') end

local function notify()
  local handle = vim.uv.fs_scandir(dir)
  if not handle then return end
  while true do
    local name = vim.uv.fs_scandir_next(handle)
    if not name then return end
    if name:match('^%d+%.sock$') then
      -- Synchronous connect, so the poke lands even from VimLeavePre. A dead
      -- popup's leftover socket refuses at once.
      local ok, chan = pcall(vim.fn.sockconnect, 'pipe', dir .. '/' .. name, { rpc = false })
      if ok and type(chan) == 'number' and chan > 0 then pcall(vim.fn.chanclose, chan) end
    end
  end
end

vim.api.nvim_create_autocmd('User', {
  group = vim.api.nvim_create_augroup('agents_picker_notify', { clear = true }),
  pattern = 'CcStateChanged',
  callback = notify,
})
