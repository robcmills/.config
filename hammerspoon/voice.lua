-- Voice command module
-- Two-stage: wake word ("computer") → command listener → action
local M = {}

local WAKE_WORD = "computer"
local TIMEOUT_SECONDS = 5

local wakeListener = nil
local cmdListener = nil
local timeoutTimer = nil

-- Commands and their actions
local commands = {
  ["whisper"] = function()
    hs.execute('open -g "wispr-flow://start-hands-free"')
  end,
  ["open terminal"] = function()
    hs.application.launchOrFocus("Alacritty")
  end,
  ["open browser"] = function()
    hs.application.launchOrFocus("Zen Browser")
  end,
  ["open slack"] = function()
    hs.application.launchOrFocus("Slack")
  end,
  ["open finder"] = function()
    hs.application.launchOrFocus("Finder")
  end,
}

local function commandNames()
  local names = {}
  for name, _ in pairs(commands) do
    names[#names + 1] = name
  end
  return names
end

local function backToWake()
  if timeoutTimer then
    timeoutTimer:stop()
    timeoutTimer = nil
  end
  if cmdListener then cmdListener:stop() end
  if wakeListener then wakeListener:start() end
end

local function onCommand(_, cmd)
  if timeoutTimer then
    timeoutTimer:stop()
    timeoutTimer = nil
  end
  if cmdListener then cmdListener:stop() end

  local action = commands[cmd]
  if action then
    hs.alert.show(">> " .. cmd, 1.5)
    -- Delay action to let the speech listener fully release
    hs.timer.doAfter(0.3, function()
      action()
      -- Return to wake word listening
      hs.timer.doAfter(0.5, backToWake)
    end)
  else
    hs.timer.doAfter(0.5, backToWake)
  end
end

local function onWake(_, _)
  if wakeListener then wakeListener:stop() end

  -- Play a chime and show alert
  hs.sound.getByName("Tink"):play()
  hs.alert.show("Listening...", 1.5)

  -- Start command listener with timeout
  if cmdListener then cmdListener:start() end
  timeoutTimer = hs.timer.doAfter(TIMEOUT_SECONDS, function()
    hs.alert.show("(timed out)", 1)
    backToWake()
  end)
end

local function hideSpeechWindow()
  hs.timer.doAfter(0.5, function()
    local app = hs.application.get("Hammerspoon")
    if not app then return end
    for _, w in ipairs(app:allWindows()) do
      local title = w:title() or ""
      if title ~= "Hammerspoon Console" then
        w:close()
      end
    end
  end)
end

function M.start()
  -- Wake word listener
  wakeListener = hs.speech.listener.new("VoiceWake")
  wakeListener:commands({WAKE_WORD})
  wakeListener:setCallback(onWake)

  -- Command listener
  cmdListener = hs.speech.listener.new("VoiceCmd")
  cmdListener:commands(commandNames())
  cmdListener:setCallback(onCommand)

  wakeListener:start()
  hideSpeechWindow()
  hs.alert.show("Voice commands active", 2)
end

function M.stop()
  if timeoutTimer then timeoutTimer:stop() end
  if wakeListener then wakeListener:stop() end
  if cmdListener then cmdListener:stop() end
end

-- Add new commands dynamically
function M.addCommand(name, action)
  commands[name] = action
  -- Rebuild command listener if it exists
  if cmdListener then
    cmdListener:commands(commandNames())
  end
end

return M
