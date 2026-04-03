<?php
header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json');

$endpoint = $_GET['e'] ?? 'status';
$allowed = ['status', 'team'];
if (!in_array($endpoint, $allowed)) { echo '{"error":"not allowed"}'; exit; }

$url = 'http://91.98.124.212:5009/api/' . $endpoint;
$opts = ['http' => ['header' => "x-api-key: emden-super-secret-key-2026\r\n", 'timeout' => 8]];
$ctx = stream_context_create($opts);
$result = @file_get_contents($url, false, $ctx);

if ($result === false) { echo '{"error":"bot offline"}'; exit; }
echo $result;
