<?php
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, x-api-key, Authorization');
header('Access-Control-Max-Age: 86400');

// CORS Preflight (Android WebView schickt OPTIONS vor POST mit JSON-Body)
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$endpoint = $_GET['e'] ?? 'status';

// Helper: cURL Request
function curlGet($url, $headers = [], $timeout = 10) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_USERAGENT, 'Emden-Network-Website');
    if (!empty($headers)) curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    $result = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['body' => $result, 'code' => $code];
}

// === DOWNLOAD PROXY (streamt die Datei direkt vom Server) ===
if ($endpoint === 'download') {
    $type = $_GET['type'] ?? 'exe';  // exe / apk / dmg

    $res = curlGet('https://api.github.com/repos/princearmy2024/Emden-Network/releases/latest', [], 8);
    if (!$res['body'] || $res['code'] !== 200) {
        http_response_code(503);
        exit('GitHub API nicht erreichbar (HTTP ' . $res['code'] . ')');
    }
    $data = json_decode($res['body'], true);
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
        exit('Datei nicht gefunden (' . $type . ')');
    }

    // Einfachster Weg: Redirect auf den GitHub-Download-Link
    // (Streaming ueber PHP wuerde bei grossen Files Memory/Timeout-Probleme verursachen)
    header('Location: ' . $asset['browser_download_url']);
    exit;
}

// === API PROXY (Bot Endpoints) ===
header('Content-Type: application/json');

// Erlaubte Endpoints (sowohl GET als auch POST)
$allowedGet  = ['status', 'team', 'mod-history', 'mod-log', 'on-duty', 'gsg9', 'mobile-version', 'shifts', 'streaks'];
$allowedPost = ['verify', 'heartbeat', 'mod-action', 'check-staff', 'check-lead', 'shift/start', 'shift/pause', 'shift/end'];

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$isPost = $method === 'POST';

if ($isPost) {
    if (!in_array($endpoint, $allowedPost)) { echo '{"error":"not allowed"}'; exit; }
} else {
    if (!in_array($endpoint, $allowedGet)) { echo '{"error":"not allowed"}'; exit; }
}

// Query-String anhaengen (z.B. ?userId=123)
$qs = $_GET;
unset($qs['e']);
$queryString = !empty($qs) ? '?' . http_build_query($qs) : '';

$url = 'http://91.98.124.212:5009/api/' . $endpoint . $queryString;
$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 15);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'x-api-key: emden-super-secret-key-2026',
    'Content-Type: application/json',
]);

if ($isPost) {
    curl_setopt($ch, CURLOPT_POST, true);
    $body = file_get_contents('php://input');
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}

$result = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if (!$result) { echo '{"error":"bot offline"}'; exit; }
http_response_code($code ?: 200);
echo $result;
