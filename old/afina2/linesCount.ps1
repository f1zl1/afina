$extensions = @(
    ".js", ".mjs", ".cjs",
    ".ts", ".tsx", ".jsx",
    ".json",
    ".css", ".html"
)

$excludeDirs = @(
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage"
)

$files = Get-ChildItem -Path . -Recurse -File |
    Where-Object {
        $file = $_

        # Перевіряємо розширення
        if ($extensions -notcontains $file.Extension.ToLower()) {
            return $false
        }

        # Перевіряємо кожну директорію в шляху
        $relativePath = $file.FullName.Substring(
            (Get-Location).Path.Length
        )

        $parts = $relativePath -split '[\\/]'

        foreach ($dir in $excludeDirs) {
            if ($parts -contains $dir) {
                return $false
            }
        }

        return $true
    }

$total = 0

foreach ($file in $files) {
    $count = @(
        Get-Content -LiteralPath $file.FullName |
        Where-Object {
            -not [string]::IsNullOrWhiteSpace($_)
        }
    ).Count

    $total += $count

    $relative = Resolve-Path -Relative $file.FullName

    Write-Host ("{0,7}  {1}" -f $count, $relative)
}

Write-Host ""
Write-Host "========================================"
Write-Host "Files:           $($files.Count)"
Write-Host "Non-empty lines: $total"
Write-Host "========================================"