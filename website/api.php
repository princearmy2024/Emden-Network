<?php
header('Access-Control-Allow-Origin: *');

$endpoint = $_GET['e'] ?? 'status';

// === DOWNLOAD REDIRECT (immer neueste Datei aus GitHub Release) ===
if ($endpoint === 'download') {
    $type = $_GET['type'] ?? 'exe';  // exe / apk / dmg
    $api = @file_get_contents('https://api.github.com/repos/princearmy2024/Emden-Network/releases/latest', false, stream_context_create([
        'http' => ['header' => "User-Agent: Emden-Network-Website\r\n", 'timeout' => 5]
    ]));
    if ($api === false) {
        header('Location: https://github.com/princearmy2024/Emden-Network/releases/latest');
        exit;
    }
    $data = json_decode($api, true);
    if (!$data || empty($data['assets'])) {
        header('Location: https://github.com/princearmy2024/Emden-Network/releases/latest');
        exit;
    }
    $ext = '.' . strtolower($type);
    foreach ($data['assets'] as $asset) {
        if (str_ends_with(strtolower($asset['name']), $ext)) {
            header('Location: ' . $asset['browser_download_url']);
            exit;
        }
    }
    // Fallback wenn nichts gefunden
    header('Location: https://github.com/princearmy2024/Emden-Network/releases/latest');
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
