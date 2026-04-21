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

// === MOBILE VERSION (dynamisch aus GitHub Latest Release) ===
if ($endpoint === 'mobile-version') {
    header('Content-Type: application/json');
    $res = curlGet('https://api.github.com/repos/princearmy2024/Emden-Network/releases/latest', [], 8);
    if ($res['code'] !== 200 || !$res['body']) {
        echo json_encode(['success' => false, 'error' => 'GitHub API unreachable']);
        exit;
    }
    $rel = json_decode($res['body'], true);
    $tag = ltrim($rel['tag_name'] ?? '0.0.0', 'v');
    // Changelog aus Release-Body (erste 5 nicht-leere Zeilen)
    $body = $rel['body'] ?? '';
    $lines = array_values(array_filter(array_map('trim', explode("\n", $body)), fn($l) => strlen($l) > 2 && !str_contains($l, 'Co-Authored')));
    $changelog = array_map(fn($l) => preg_replace('/^[-*•]\s*/', '', $l), array_slice($lines, 0, 5));
    if (empty($changelog)) $changelog = ['Bugfixes und Verbesserungen'];
    echo json_encode([
        'success' => true,
        'version' => $tag,
        'apkUrl' => "https://github.com/princearmy2024/Emden-Network/releases/download/v{$tag}/Emden-Network-Mobile.apk",
        'changelog' => $changelog,
        'mandatory' => false,
    ]);
    exit;
}

// === ROBLOX PROXY (umgeht CORS auf Android) ===
if ($endpoint === 'roblox-search') {
    header('Content-Type: application/json');
    $q = trim($_GET['q'] ?? '');
    if ($q === '') { echo '{"error":"q required"}'; exit; }

    $users = [];
    if (ctype_digit($q)) {
        // ID-Suche
        $r = curlGet('https://users.roblox.com/v1/users/' . $q, [], 8);
        if ($r['code'] === 200 && $r['body']) {
            $u = json_decode($r['body'], true);
            if ($u && !empty($u['id'])) $users[] = $u;
        }
    } else {
        // Username-Suche via POST
        $ch = curl_init('https://users.roblox.com/v1/usernames/users');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 8);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['usernames' => [$q], 'excludeBannedUsers' => false]));
        $body = curl_exec($ch);
        curl_close($ch);
        $data = json_decode($body, true);
        if (!empty($data['data'])) {
            foreach (array_slice($data['data'], 0, 5) as $u) {
                $r = curlGet('https://users.roblox.com/v1/users/' . $u['id'], [], 5);
                $full = $r['code'] === 200 ? json_decode($r['body'], true) : $u;
                if ($full) $users[] = $full;
            }
        }
    }

    // Avatare batch holen
    $avatars = [];
    if (!empty($users)) {
        $ids = implode(',', array_column($users, 'id'));
        $r = curlGet('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' . $ids . '&size=150x150&format=Png', [], 5);
        if ($r['code'] === 200 && $r['body']) {
            $av = json_decode($r['body'], true);
            foreach (($av['data'] ?? []) as $a) $avatars[$a['targetId']] = $a['imageUrl'] ?? null;
        }
    }
    foreach ($users as &$u) { $u['avatar'] = $avatars[$u['id']] ?? null; }

    echo json_encode(['success' => true, 'users' => $users]);
    exit;
}

// === API PROXY (Bot Endpoints) ===
header('Content-Type: application/json');

// Erlaubte Endpoints (sowohl GET als auch POST)
$allowedGet  = ['status', 'team', 'mod-history', 'mod-log', 'on-duty', 'gsg9', 'mobile-version', 'shifts', 'streaks', 'storage', 'roblox/profile', 'support-cases/open'];
$allowedPost = ['verify', 'heartbeat', 'mod-action', 'check-staff', 'check-lead', 'shift/start', 'shift/pause', 'shift/end', 'shift/manage', 'link-roblox', 'roblox/start-verify', 'roblox/confirm-verify', 'support-case/take'];

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
