-- Must run this to set non-default config dir
-- defaults write org.hammerspoon.Hammerspoon MJConfigFile "~/.config/hammerspoon/init.lua"
-- https://github.com/Hammerspoon/hammerspoon/pull/582

-- enable hs cli
require("hs.ipc")

-- U.S. (ANSI) keycodes for letters. Bindings use these instead of letter
-- strings because hs.hotkey.bind resolves a string to a keycode once, at bind
-- time, against whatever layout is active. Binding by keycode pins each hotkey
-- to a physical key regardless of layout (U.S. vs Colemak).
local KEYS = {
  A = 0, B = 11, C = 8, D = 2, E = 14, F = 3, G = 5, H = 4, I = 34,
  J = 38, K = 40, L = 37, M = 46, N = 45, O = 31, P = 35, Q = 12, R = 15,
  S = 1, T = 17, U = 32, V = 9, W = 13, X = 7, Y = 16, Z = 6,
}

-- Fast app switching
local fast_apps = {
  [KEYS.A] = 'Alacritty',
  [KEYS.B] = 'Brave Browser',
  [KEYS.C] = 'Google Chrome',
  [KEYS.E] = 'Microsoft Edge',
  [KEYS.F] = 'Finder',
  [KEYS.G] = 'Godot',
  [KEYS.I] = 'Intellij IDEA',
  [KEYS.M] = 'Google Meet',
  [KEYS.P] = '1Password',
  [KEYS.R] = 'Cursor',
  [KEYS.S] = 'Slack',
  [KEYS.T] = 'Cypress',
  [KEYS.V] = 'Visual Studio Code',
  [KEYS.W] = 'Warp',
  [KEYS.Y] = 'Activity Monitor',
  [KEYS.Z] = 'Zen Browser',
}
for key, app in pairs(fast_apps) do
  hs.hotkey.bind({ 'cmd', 'alt', 'ctrl', 'shift' }, key, function()
    hs.application.launchOrFocus(app)
  end)
end

-- Fast tmux window selection
for i = 0, 9, 1 do
  hs.hotkey.bind({ 'cmd', 'alt', 'ctrl', 'shift' }, '' .. i, function()
    hs.eventtap.keyStroke({ 'ctrl' }, 'x')
    hs.eventtap.keyStroke(nil, '' .. i)
  end)
end

-- Fast keyboard layout switching
hs.hotkey.bind({ 'cmd', 'alt', 'ctrl', 'shift' }, KEYS.K, function()
  local current = hs.keycodes.currentLayout()
  hs.keycodes.setLayout(current == 'U.S.' and 'Colemak' or 'U.S.')
end)


-- Reload hammerspoon config
hs.hotkey.bind({ 'cmd', 'alt', 'ctrl', 'shift' }, KEYS.H, function()
  hs.reload()
end)

-- Voice command system (wake word + commands)
-- local voice = require("voice")
-- voice.start()

hs.alert.show('Config loaded')
