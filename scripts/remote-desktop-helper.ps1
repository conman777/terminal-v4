param([switch]$DryRun, [switch]$Fixture, [string]$RequestJson)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
if (-not $RequestJson) { $RequestJson = [Console]::In.ReadToEnd() }
if ($RequestJson.Length -gt 4096) { throw 'Desktop request exceeds limit.' }
$request = $RequestJson | ConvertFrom-Json
if (@('status', 'frame', 'input') -notcontains $request.command) { throw 'Unknown desktop command.' }
$mode = $env:TERMINAL_V4_DESKTOP_ACCESS
if (-not $DryRun -and -not $Fixture -and @('view', 'control') -notcontains $mode) { throw 'Desktop access is disabled on this host.' }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TerminalDesktopNative {
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
 public static void Send(INPUT[] values) {
  if (SendInput((uint)values.Length,values,Marshal.SizeOf(typeof(INPUT))) != values.Length) throw new InvalidOperationException("Windows rejected desktop input. Check the interactive desktop and application elevation.");
 }
 public static INPUT Key(ushort vk, ushort scan, uint flags) { return new INPUT {type=1,data=new UNION {key=new KEYBDINPUT{vk=vk,scan=scan,flags=flags}}}; }
 public static INPUT Mouse(int x,int y,uint flags,uint data) {return new INPUT{type=0,data=new UNION{mouse=new MOUSEINPUT{dx=x,dy=y,dwFlags=flags,mouseData=data}}};}
 public static INPUT Position(int x,int y) {
  int left=GetSystemMetrics(76), top=GetSystemMetrics(77), width=GetSystemMetrics(78), height=GetSystemMetrics(79);
  if(width<2 || height<2) throw new InvalidOperationException("Interactive desktop geometry is unavailable.");
  int nx=(int)Math.Round((x-left)*65535.0/(width-1)), ny=(int)Math.Round((y-top)*65535.0/(height-1));
  return Mouse(Math.Max(0,Math.Min(65535,nx)),Math.Max(0,Math.Min(65535,ny)),0xC001,0);
 }
}
'@
if ($DryRun -or $Fixture) { $screens = @() } else {
    $null = [TerminalDesktopNative]::SetProcessDPIAware()
    if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0 -or -not [Environment]::UserInteractive) { throw 'An interactive Windows user session is required.' }
    $screens = @([Windows.Forms.Screen]::AllScreens)
}
if ($request.command -eq 'status') {
    @{ available = $true; monitors = @($screens | ForEach-Object { @{ id=$_.DeviceName; label=$_.DeviceName; primary=$_.Primary; width=$_.Bounds.Width; height=$_.Bounds.Height; left=$_.Bounds.Left; top=$_.Bounds.Top } }) } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}
if ($request.command -eq 'frame') {
    if ($DryRun) { throw 'A dry run cannot capture a desktop.' }
    if ($Fixture) { $bounds = New-Object Drawing.Rectangle(0,0,320,180) }
    else {
        $screen = $screens | Where-Object DeviceName -CEQ $request.monitor | Select-Object -First 1
        if (-not $screen) { throw 'Selected monitor is unavailable.' }
        $bounds = $screen.Bounds
    }
    if ($bounds.Width -le 0 -or $bounds.Height -le 0 -or ([long]$bounds.Width * $bounds.Height) -gt 32000000) { throw 'Monitor geometry exceeds capture limits.' }
    $source = New-Object Drawing.Bitmap($bounds.Width,$bounds.Height)
    $graphics = [Drawing.Graphics]::FromImage($source)
    $output = $null; $scaledGraphics = $null; $memory = $null; $parameters = $null
    try {
        if ($Fixture) { $graphics.Clear([Drawing.Color]::CornflowerBlue) }
        else { $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bounds.Size,[Drawing.CopyPixelOperation]::SourceCopy) }
        $scale = [Math]::Min(1,[Math]::Min(1600.0/$bounds.Width,1000.0/$bounds.Height))
        $width = [Math]::Max(1,[int][Math]::Floor($bounds.Width*$scale))
        $height = [Math]::Max(1,[int][Math]::Floor($bounds.Height*$scale))
        $output = New-Object Drawing.Bitmap($width,$height)
        $scaledGraphics = [Drawing.Graphics]::FromImage($output)
        $scaledGraphics.DrawImage($source,0,0,$width,$height)
        $encoder = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -EQ 'image/jpeg' | Select-Object -First 1
        $parameters = New-Object Drawing.Imaging.EncoderParameters(1)
        $parameters.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality,[long]60)
        $memory = New-Object IO.MemoryStream
        $output.Save($memory,$encoder,$parameters)
        $bytes = $memory.ToArray()
        if ($bytes.Length -gt 4000000) { throw 'Desktop frame exceeds output limit.' }
        [Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)
    } finally {
        if ($parameters) {$parameters.Dispose()}
        if ($memory) {$memory.Dispose()}
        if ($scaledGraphics) {$scaledGraphics.Dispose()}
        if ($output) {$output.Dispose()}
        $graphics.Dispose(); $source.Dispose()
    }
    exit 0
}
if (-not $DryRun -and $mode -ne 'control') { throw 'Desktop control is disabled on this host.' }
$inputCommand = $request.input
$values = New-Object 'Collections.Generic.List[TerminalDesktopNative+INPUT]'
$keyMap = @{ Enter=13; Escape=27; Tab=9; Backspace=8; Delete=46; Space=32; ArrowLeft=37; ArrowUp=38; ArrowRight=39; ArrowDown=40; Home=36; End=35; PageUp=33; PageDown=34; Insert=45 }
$modifierMap = @{ Control=17; Alt=18; Shift=16; Meta=91 }
switch -CaseSensitive ($inputCommand.kind) {
    'pointer' {
        $x = [double]$inputCommand.x; $y = [double]$inputCommand.y
        if ([double]::IsNaN($x) -or [double]::IsInfinity($x) -or [double]::IsNaN($y) -or [double]::IsInfinity($y) -or $x -lt 0 -or $x -gt 1 -or $y -lt 0 -or $y -gt 1) {throw 'Invalid pointer coordinates.'}
        if (@('move','click','rightClick') -cnotcontains $inputCommand.action) {throw 'Invalid pointer action.'}
        if (-not $DryRun) {
            $screen = $screens | Where-Object DeviceName -CEQ $request.monitor | Select-Object -First 1
            if (-not $screen) {throw 'Selected monitor is unavailable.'}
            $bounds = $screen.Bounds
            $values.Add([TerminalDesktopNative]::Position($bounds.Left+[int][Math]::Round($x*($bounds.Width-1)), $bounds.Top+[int][Math]::Round($y*($bounds.Height-1))))
            if ($inputCommand.action -eq 'click') {$values.Add([TerminalDesktopNative]::Mouse(0,0,2,0)); $values.Add([TerminalDesktopNative]::Mouse(0,0,4,0))}
            if ($inputCommand.action -eq 'rightClick') {$values.Add([TerminalDesktopNative]::Mouse(0,0,8,0)); $values.Add([TerminalDesktopNative]::Mouse(0,0,16,0))}
        }
    }
    'key' {
        $key = [string]$inputCommand.key
        $vk = $keyMap[$key]
        if ($key -cmatch '^Key[A-Z]$') {$vk = [int][char]$key[3]}
        if ($key -cmatch '^Digit[0-9]$') {$vk = [int][char]$key[5]}
        if ($key -cmatch '^F([1-9]|1[0-2])$') {$vk = 111 + [int]$Matches[1]}
        if (-not $vk) {throw 'Unsupported key.'}
        if (@($inputCommand.modifiers).Count -gt 4) {throw 'Too many modifiers.'}
        foreach ($modifier in $inputCommand.modifiers) {
            if (@('Control','Alt','Shift','Meta') -cnotcontains $modifier) {throw 'Unsupported key modifier.'}
            $values.Add([TerminalDesktopNative]::Key([uint16]$modifierMap[$modifier],0,0))
        }
        $values.Add([TerminalDesktopNative]::Key([uint16]$vk,0,0)); $values.Add([TerminalDesktopNative]::Key([uint16]$vk,0,2))
        $modifiers = @($inputCommand.modifiers)
        for ($index=$modifiers.Count-1; $index -ge 0; $index--) {$values.Add([TerminalDesktopNative]::Key([uint16]$modifierMap[$modifiers[$index]],0,2))}
    }
    'text' {
        $text = [string]$inputCommand.text
        if ($text.Length -lt 1 -or $text.Length -gt 256 -or $text -match '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]') {throw 'Text exceeds supported input limits.'}
        foreach ($character in $text.ToCharArray()) {$values.Add([TerminalDesktopNative]::Key(0,[uint16]$character,4)); $values.Add([TerminalDesktopNative]::Key(0,[uint16]$character,6))}
    }
    'wheel' {
        $delta=[int]$inputCommand.delta
        if ($delta -eq 0 -or $delta -lt -1200 -or $delta -gt 1200 -or $delta % 120 -ne 0) {throw 'Unsupported scroll delta.'}
        $unsigned = [BitConverter]::ToUInt32([BitConverter]::GetBytes($delta),0)
        $values.Add([TerminalDesktopNative]::Mouse(0,0,0x800,$unsigned))
    }
    default {throw 'Unsupported input command.'}
}
if (-not $DryRun) {[TerminalDesktopNative]::Send($values.ToArray())}
@{accepted=$true; dryRun=[bool]$DryRun; count=$values.Count} | ConvertTo-Json -Compress
