# Serves Tone Coach on http://localhost and opens it in the browser.
# Started by "Start Tone Coach.bat". Uses only what ships with Windows.

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$sep = [IO.Path]::DirectorySeparatorChar

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.mp3'  = 'audio/mpeg'
  '.png'  = 'image/png'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

# Use the first free port from 8000 upwards.
$listener = $null
foreach ($port in 8000..8020) {
  $candidate = New-Object System.Net.HttpListener
  $candidate.Prefixes.Add("http://localhost:$port/")
  try { $candidate.Start(); $listener = $candidate; break } catch { $candidate.Close() }
}
if (-not $listener) {
  Write-Host 'Could not start: ports 8000-8020 are all in use.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

$url = "http://localhost:$port/"
Write-Host ''
Write-Host "  Tone Coach is running at $url" -ForegroundColor Green
Write-Host '  Keep this window open while practicing. Close it to stop.'
Write-Host ''
try { Start-Process $url } catch { Write-Host "  Open $url in your browser." }

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $response = $context.Response
  try {
    $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
    if ($path.EndsWith('/')) { $path += 'index.html' }
    $file = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $path.TrimStart('/').Replace('/', $sep)))

    if ($file.StartsWith($root) -and [IO.File]::Exists($file)) {
      $type = $types[[IO.Path]::GetExtension($file).ToLower()]
      if (-not $type) { $type = 'application/octet-stream' }
      $bytes = [IO.File]::ReadAllBytes($file)
      $response.ContentType = $type
      $response.Headers.Add('Cache-Control', 'no-cache')
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $response.StatusCode = 404
    }
  } catch {
    $response.StatusCode = 500
  } finally {
    $response.Close()
  }
}
