<?php
header('Access-Control-Allow-Origin: *');

$endpoint = $_GET['e'] ?? 'status';

// === DOWNLOAD PROXY (streamt die Datei direkt vom Server) ===
if ($endpoint === 'download') {
    $type = $_GET['type'] ?? 'exe';  // exe / apk / dmg
    $api = @file_get_contents('https://api.github.com/repos/princearmy2024/Emden-Network/releases/latest', false, stream_context_create([
        'http' => ['header' => "User-Agent: Emden-Network-Website\r\n", 'timeout' => 5]
    ]));
    if ($api === false) {
        http_response_code(503);
        exit('Bot offline');
    }
    $data = json_decode($api, true);
    if (!$data || empty($data['assets'])) {
        http_response_code(404);
        exit('Kein Release verfuegbar');
    }
    $ext = '.' . strtolower($type);
    $asset = null;
    foreach ($data['assets'] as $a) {
        if (str_ends_with(strtolower($a['name']), $ext)) { $asset = $a; break; }
    }
    if (!$asset) {
        http_response_code(404);
        exit('Datei nicht gefunden');
    }

    // Filename + MIME bestimmen
    $filename = $asset['name'];
    $mime = match($type) {
        'exe' => 'application/vnd.microsoft.portable-executable',
        'apk' => 'application/vnd.android.package-archive',
        'dmg' => 'application/x-apple-diskimage',
        default => 'application/octet-stream',
    };

    // Download-Headers setzen
    header('Content-Type: ' . $mime);
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Content-Length: ' . $asset['size']);
    header('Cache-Control: no-cache, must-revalidate');
    header('Pragma: no-cache');

    // Datei streamen (mit fopen damit grosse Files nicht in den RAM geladen werden)
    $ctx = stream_context_create([
        'http' => ['header' => "User-Agent: Emden-Network-Website\r\n", 'timeout' => 60]
    ]);
    $stream = @fopen($asset['browser_download_url'], 'rb', false, $ctx);
    if ($stream === false) {
        http_response_code(502);
        exit('Download fehlgeschlagen');
    }
    while (!feof($stream)) {
        echo fread($stream, 65536);
        flush();
    }
    fclose($stream);
    exit;
}

// === API PROXY (Bot Endpoints) ===
header('Content-Type: application/json');
$allowed = ['status', 'team'];
if (!in_array($endpoint, $allowed)) { echo '{"error":"not allowed"}'; exit; }

$url = 'http://91.98.124.212:5009/api/' . $endpoint;
$opts = ['http' => ['header' => "x-api-key: emden-super-secret-key-2026\r\n", 'timeout' => 8]];
$ctx = stream_context_create($opts);
$result = @file_get_contents($url, false, $ctx);

if ($result === false) { echo '{"error":"bot offline"}'; exit; }
echo $result;
