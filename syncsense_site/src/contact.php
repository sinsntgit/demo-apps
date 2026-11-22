<?php
// Contact form handler for syncsense.in.
// Emails form submissions to sales@syncsense.in, then sends the visitor
// back to the page they came from with ?status=sent or ?status=error.

const TO_EMAIL   = 'sales@syncsense.in';
const FROM_EMAIL = 'no-reply@syncsense.in';
const FROM_NAME  = 'SyncSense Website';

function back(string $status): void {
    $ref  = $_SERVER['HTTP_REFERER'] ?? '';
    $host = preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? '');
    $path = '/get-in-touch';
    $parts = $ref !== '' ? parse_url($ref) : false;
    // Only return to a page on this same site.
    if ($parts && isset($parts['host'], $parts['path']) && strcasecmp($parts['host'], $host) === 0
        && preg_match('#^/[A-Za-z0-9/_-]*$#', $parts['path'])) {
        $path = $parts['path'];
    }
    header('Location: ' . $path . '?status=' . $status . '#contact', true, 303);
    exit;
}

function field(string $name, int $max): string {
    $v = isset($_POST[$name]) && is_string($_POST[$name]) ? trim($_POST[$name]) : '';
    $v = str_replace(["\0"], '', $v);
    return mb_substr($v, 0, $max);
}

function oneLine(string $v): string {
    return trim(preg_replace('/[\r\n\t]+/', ' ', $v));
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Location: /get-in-touch', true, 303);
    exit;
}

// Bots fill the hidden "website" field; pretend success and send nothing.
if (field('website', 200) !== '') {
    back('sent');
}

$name    = oneLine(field('name', 120));
$email   = oneLine(field('email', 200));
$company = oneLine(field('company', 160));
$phone   = oneLine(field('phone', 40));
$message = field('message', 5000);
$source  = oneLine(field('source', 80));

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    back('error');
}
if ($phone !== '' && !preg_match('/^[0-9+()\-\s.]{6,40}$/', $phone)) {
    back('error');
}

$isSignup = $message === '' && $name === '';
$subject  = $isSignup
    ? 'Website: insights request from ' . $email
    : 'Website inquiry from ' . ($name !== '' ? $name : $email);

$lines = [
    'Form:    ' . ($source !== '' ? $source : 'Website'),
    'Name:    ' . ($name !== '' ? $name : '-'),
    'Email:   ' . $email,
];
if ($company !== '') { $lines[] = 'Company: ' . $company; }
if ($phone !== '')   { $lines[] = 'Phone:   ' . $phone; }
$lines[] = '';
$lines[] = $message !== '' ? $message : '(No message: visitor asked to stay updated on digital transformation solutions.)';
$lines[] = '';
$lines[] = '--';
$lines[] = 'Sent ' . gmdate('Y-m-d H:i') . ' UTC from ' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown IP');
$body = implode("\r\n", $lines);

$encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
$headers = [
    'From: ' . FROM_NAME . ' <' . FROM_EMAIL . '>',
    'Reply-To: ' . $email,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'X-Mailer: syncsense-site',
];

$ok = mail(TO_EMAIL, $encodedSubject, $body, implode("\r\n", $headers), '-f' . FROM_EMAIL);
back($ok ? 'sent' : 'error');
