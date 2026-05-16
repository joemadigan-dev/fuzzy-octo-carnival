# Creates a Windows Task Scheduler entry to run the lottery agent
# every Wednesday and Saturday at 17:00 Irish time.
#
# Run once in an Administrator PowerShell window:
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser   # one-time
#   .\setup_windows_task.ps1

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonExe  = (Get-Command python).Source
$BotScript  = Join-Path $ScriptDir "lottery_bot.py"
$TaskName   = "LotteryIeAgent"

if (-not (Test-Path $BotScript)) {
    Write-Error "Could not find lottery_bot.py at $BotScript"
    exit 1
}

# Action: run python lottery_bot.py
$Action = New-ScheduledTaskAction `
    -Execute $PythonExe `
    -Argument "`"$BotScript`"" `
    -WorkingDirectory $ScriptDir

# Trigger: every Wednesday (DaysOfWeek 3) and Saturday (DaysOfWeek 6) at 17:00
$TriggerWed = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Wednesday -At "17:00"
$TriggerSat = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday  -At "17:00"

# Settings
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable  # catch up if machine was off at trigger time

# Environment variables for credentials
# These are set as process-level env vars for the task.
$EnvBlock = "LOTTERY_EMAIL=$env:LOTTERY_EMAIL;LOTTERY_PASSWORD=$env:LOTTERY_PASSWORD;LOTTERY_HEADLESS=false"

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType InteractiveToken

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $Action `
    -Trigger   @($TriggerWed, $TriggerSat) `
    -Settings  $Settings `
    -Principal $Principal `
    -Force | Out-Null

Write-Host "Task '$TaskName' registered successfully."
Write-Host ""
Write-Host "IMPORTANT: The task inherits the env vars of the account that runs it."
Write-Host "Set LOTTERY_EMAIL and LOTTERY_PASSWORD as permanent user environment"
Write-Host "variables in Control Panel > System > Advanced > Environment Variables,"
Write-Host "OR copy .env.example to .env in the lottery_agent/ folder."
Write-Host ""
Write-Host "Verify in Task Scheduler (taskschd.msc) under Task Scheduler Library."
Write-Host "NOTE: Ireland is in the Europe/Dublin timezone (UTC+1 in summer, UTC+0 in winter)."
Write-Host "Adjust the trigger time if your machine uses a different timezone."
