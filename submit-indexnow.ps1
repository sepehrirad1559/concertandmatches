$ErrorActionPreference = 'Stop'

Write-Host "Fetching sitemap..."
$sitemap = Invoke-RestMethod -Uri 'https://concertandmatches-production.up.railway.app/sitemap.xml' -UseBasicParsing
$xml = [xml]$sitemap
$eventUrls = $xml.urlset.url | ForEach-Object { $_.loc }

$urlList = @('https://www.concertandmatches.com/', 'https://www.concertandmatches.com/guide') + $eventUrls
Write-Host "Submitting $($urlList.Count) URLs to IndexNow..."

$body = @{
    host        = 'www.concertandmatches.com'
    key         = 'a9244500c3cbbb799c1bed36454f10b8'
    keyLocation = 'https://www.concertandmatches.com/a9244500c3cbbb799c1bed36454f10b8.txt'
    urlList     = $urlList
} | ConvertTo-Json -Depth 4 -Compress

try {
    $response = Invoke-WebRequest -Uri 'https://api.indexnow.org/indexnow' -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -UseBasicParsing
    Write-Host "Response status: $($response.StatusCode) $($response.StatusDescription)"
} catch {
    Write-Host "Request failed:" $_.Exception.Message
    if ($_.Exception.Response) {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        Write-Host "Response body:" $reader.ReadToEnd()
    }
}
