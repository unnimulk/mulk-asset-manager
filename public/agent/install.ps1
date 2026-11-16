# Installs Mulk Agent on this Windows computer. Run it from an Administrator PowerShell.
# The person who uses the computer can see the Mulk Agent window. It is not a hidden install.
param(
  [string]$Code,
  [string]$WindowsUser,
  [string]$Origin = 'https://mulk-asset-manager.vercel.app'
)

$ErrorActionPreference = 'Stop'
$Root = 'C:\ProgramData\MulkAgent'
$Origin = $Origin.TrimEnd('/')

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Host 'Run this setup as Administrator. Right-click PowerShell, then Run as administrator.'
  exit 1
}

if (-not $Code) { $Code = Read-Host 'Enter the 8 character code from Control' }
if (-not $WindowsUser) {
  $current = whoami
  $WindowsUser = Read-Host "Windows account to manage [$current]"
  if (-not $WindowsUser) { $WindowsUser = $current }
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$agentFile = Join-Path $Root 'MulkAgent.ps1'
Invoke-WebRequest -Uri ($Origin + '/agent/MulkAgent.ps1') -OutFile $agentFile -UseBasicParsing

$configRes = Invoke-WebRequest -Uri ($Origin + '/api/config') -UseBasicParsing
$public = $configRes.Content | ConvertFrom-Json
if (-not $public.supabaseUrl -or -not $public.supabaseAnonKey) {
  throw 'The asset app is not connected to its database yet.'
}

$headers = @{
  apikey = $public.supabaseAnonKey
  Authorization = 'Bearer ' + $public.supabaseAnonKey
  'Content-Type' = 'application/json'
}
$body = @{ p_code = $Code.Trim().ToUpper(); p_hostname = $env:COMPUTERNAME; p_windows_user = $WindowsUser.Trim() } | ConvertTo-Json -Compress
try {
  $enroll = Invoke-WebRequest -Uri ($public.supabaseUrl.TrimEnd('/') + '/rest/v1/rpc/agent_enroll') -Method Post -Headers $headers -Body $body -UseBasicParsing
} catch {
  $detail = $_.Exception.Message
  if ($_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
  throw "Enrollment failed. $detail"
}
$result = $enroll.Content | ConvertFrom-Json

$device = @{
  url = $public.supabaseUrl
  anon = $public.supabaseAnonKey
  token = $result.token
  windows_user = $result.windows_user
}
$devicePath = Join-Path $Root 'device.json'
$device | ConvertTo-Json | Set-Content -Path $devicePath -Encoding UTF8

function Set-LockedAcl([string]$Path, [bool]$UsersCanAppend) {
  $acl = Get-Acl -Path $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
  $system = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')).Translate([System.Security.Principal.NTAccount])
  $admins = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount])
  $users = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')).Translate([System.Security.Principal.NTAccount])
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, 'FullControl', 'Allow')))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admins, 'FullControl', 'Allow')))
  $userRight = if ($UsersCanAppend) { 'Modify' } else { 'ReadAndExecute' }
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($users, $userRight, 'Allow')))
  Set-Acl -Path $Path -AclObject $acl
}

Set-LockedAcl $agentFile $false
Set-LockedAcl $devicePath $false
New-Item -ItemType File -Force -Path (Join-Path $Root 'agent.log') | Out-Null
Set-LockedAcl (Join-Path $Root 'agent.log') $true

$startup = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\Mulk Agent.lnk'
$menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Mulk Agent.lnk'
$shell = New-Object -ComObject WScript.Shell
foreach ($linkPath in @($startup, $menu)) {
  $link = $shell.CreateShortcut($linkPath)
  $link.TargetPath = 'powershell.exe'
  $link.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\MulkAgent\MulkAgent.ps1"'
  $link.WorkingDirectory = $Root
  $link.WindowStyle = 1
  $link.Description = 'Mulk Agent'
  $link.Save()
}

$task = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\MulkAgent\MulkAgent.ps1 -Enforce'
schtasks.exe /Create /TN 'Mulk Agent Enforce' /SC MINUTE /MO 5 /RU SYSTEM /RL HIGHEST /TR $task /F | Out-Null
$watch = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\ProgramData\MulkAgent\MulkAgent.ps1 -Watch'
schtasks.exe /Create /TN 'Mulk Agent Watch' /SC MINUTE /MO 1 /RU SYSTEM /RL HIGHEST /TR $watch /F | Out-Null
$sample = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\ProgramData\MulkAgent\MulkAgent.ps1 -Sample'
schtasks.exe /Create /TN 'Mulk Agent Sample' /SC MINUTE /MO 1 /RU $WindowsUser /IT /RL LIMITED /TR $sample /F | Out-Null

Write-Host "Mulk Agent installed for $($result.tag)."
Write-Host 'The Mulk Agent window opens at sign-in. IT approves admin requests in Control.'
Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$agentFile
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentFile -Enforce
