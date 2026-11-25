param([int]$ProcessId, [string]$Keys = '', [string]$Screenshot = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class UmraWindows {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder b, int max);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  public struct Rect { public int Left,Top,Right,Bottom; }
  public static IntPtr Find(int process) {
    IntPtr result=IntPtr.Zero;
    EnumWindows((h,p)=>{ uint id; GetWindowThreadProcessId(h,out id); if(id==process && IsWindowVisible(h)){result=h;return false;} return true; },IntPtr.Zero);
    return result;
  }
  public static IntPtr Canvas(IntPtr window) {
    IntPtr result=window;
    EnumChildWindows(window,(h,p)=>{ var b=new System.Text.StringBuilder(256); GetClassName(h,b,256); if(b.ToString().Contains("Canvas") && IsWindowVisible(h)) result=h; return true; },IntPtr.Zero);
    return result;
  }
  public static void Key(IntPtr window, int key) {
    int scan=(int)MapVirtualKey((uint)key,0);
    if(!PostMessage(window,0x100,(IntPtr)key,(IntPtr)(1|(scan<<16)))) throw new System.ComponentModel.Win32Exception();
    if(!PostMessage(window,0x101,(IntPtr)key,(IntPtr)(unchecked((int)0xc0000001)|(scan<<16)))) throw new System.ComponentModel.Win32Exception();
  }
}
'@
$deadline = [Diagnostics.Stopwatch]::StartNew()
do {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        throw "Emulator process $ProcessId exited before its window was ready"
    }
    $window = [UmraWindows]::Find($ProcessId)
    if ($window -ne [IntPtr]::Zero) { break }
    [Threading.Thread]::Sleep(100)
} while ($deadline.ElapsedMilliseconds -lt 10000)
if ($window -eq [IntPtr]::Zero) { throw "No visible emulator window for process $ProcessId after 10 seconds" }
[UmraWindows]::ShowWindow($window, 9) | Out-Null
[UmraWindows]::SetForegroundWindow($window) | Out-Null
$rect = New-Object UmraWindows+Rect
[UmraWindows]::GetWindowRect($window, [ref]$rect) | Out-Null
if ($Screenshot) {
    $bitmap = New-Object Drawing.Bitmap ($rect.Right-$rect.Left), ($rect.Bottom-$rect.Top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($Screenshot, [Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
}
if ($Keys) {
    $target = [UmraWindows]::Canvas($window)
    $matches = [regex]::Matches($Keys, '\{F1\}|\{F2\}|\{ENTER\}|.')
    foreach ($match in $matches) {
        $key = if ($match.Value -eq '{F1}') { 112 } elseif ($match.Value -eq '{F2}') { 113 } elseif ($match.Value -eq '{ENTER}') { 13 } else { [int][char]$match.Value }
        [UmraWindows]::Key($target, $key)
    }
}
Write-Output "Window $window rect=$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom) keys=$Keys"
