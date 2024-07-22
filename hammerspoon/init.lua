-- Must run this to set non-default config dir
-- defaults write org.hammerspoon.Hammerspoon MJConfigFile "~/.config/hammerspoon/init.lua"
-- https://github.com/Hammerspoon/hammerspoon/pull/582

-- Fast app switching
local fast_apps = {
  A = 'Alacritty',
  B = 'Brave Browser',
  C = 'Google Chrome',
  E = 'Microsoft Edge',
  F = 'Finder',
  G = 'Preview',
  H = 'Hyper',
  I = 'Intellij IDEA',
  M = 'Google Meet',
  P = '1Password',
  S = 'Slack',
  T = 'Cypress',
  V = 'Visual Studio Code',
  W = 'Warp',
  Y = 'Activity Monitor',
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
hs.hotkey.bind({ 'cmd', 'alt', 'ctrl', 'shift' }, 'K', function()
  local current = hs.keycodes.currentLayout()
  hs.keycodes.setLayout(current == 'U.S.' and 'Colemak' or 'U.S.')
end)


-- Reload hammerspoon config
hs.hotkey.bind({ 'cmd', 'alt', 'ctrl', 'shift' }, 'R', function()
  hs.reload()
end)

hs.alert.show('Config loaded')
