<?php
// Lead form handler for www.syncsense.in.
// Emails each enquiry to sales@syncsense.in, then sends the visitor to /thank-you/
// (or back to the form with ?status=error).

const TO_EMAIL   = 'sales@syncsense.in';
const FROM_EMAIL = 'no-reply@syncsense.in';
const FROM_NAME  = 'SyncSense Website';

const INDUSTRIES = [
    'Insurance', 'Banking & Financial Services', 'Telecom', 'Tax & Professional Services',
    'Retail & E-commerce', 'Healthcare & Pharma', 'Manufacturing', 'Other',
];
const INTERESTS = [
    'demo' => 'AskData demo (Text-to-SQL)', 'ontology' => 'Ontology Studio', 'crm' => 'Ovantaa CRM',
    'assessment' => 'Free data assessment', 'consulting' => 'Data & AI consulting', 'staffing' => 'Contract staffing',
];
const SOURCES = ['demo' => 'Demo request', 'assessment' => 'Free data assessment', 'contact' => 'Contact form'];

function back_with_error(): void {
    $ref   = $_SERVER['HTTP_REFERER'] ?? '';
    $host  = preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? '');
    $path  = '/contact/';
    $parts = $ref !== '' ? parse_url($ref) : false;
    if ($parts && isset($parts['host'], $parts['path']) && strcasecmp($parts['host'], $host) === 0
        && preg_match('#^/[a-z0-9/_-]*$#', $parts['path'])) {
        $path = $parts['path'];
    }
    header('Location: ' . $path . '?status=error#form', true, 303);
    exit;
}

function field(string $name, int $max): string {
    $v = isset($_POST[$name]) && is_string($_POST[$name]) ? trim($_POST[$name]) : '';
    return mb_substr(str_replace("\0", '', $v), 0, $max);
}

function one_line(string $v): string {
    return trim(preg_replace('/[\r\n\t]+/', ' ', $v));
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Location: /contact/', true, 303);
    exit;
}

// Spam trap: bots fill the hidden "website" field. Pretend success, send nothing.
if (field('website', 200) !== '') {
    header('Location: /thank-you/', true, 303);
    exit;
}

$name     = one_line(field('name', 120));
$email    = one_line(field('email', 200));
$company  = one_line(field('company', 160));
$role     = one_line(field('role', 120));
$industry = one_line(field('industry', 60));
$message  = field('message', 5000);
$source   = SOURCES[field('source', 20)] ?? 'Website form';

$interests = [];
if (isset($_POST['interest']) && is_array($_POST['interest'])) {
    foreach ($_POST['interest'] as $i) {
        if (is_string($i) && isset(INTERESTS[$i])) { $interests[] = INTERESTS[$i]; }
    }
}

if ($name === '' || $company === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || !in_array($industry, INDUSTRIES, true)) {
    back_with_error();
}

$subject = $source . ': ' . $name . ' (' . $company . ')';
$lines = [
    'Form:        ' . $source,
    'Name:        ' . $name,
    'Work email:  ' . $email,
    'Company:     ' . $company,
    'Role:        ' . ($role !== '' ? $role : '-'),
    'Industry:    ' . $industry,
    'Interested:  ' . ($interests ? implode(', ', $interests) : '-'),
    '',
    $message !== '' ? $message : '(No message.)',
    '',
    '--',
    'Sent ' . gmdate('Y-m-d H:i') . ' UTC from ' . ($_SERVER['HTTP_REFERER'] ?? 'unknown page'),
];

$headers = [
    'From: ' . FROM_NAME . ' <' . FROM_EMAIL . '>',
    'Reply-To: ' . $email,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
];

$ok = mail(TO_EMAIL, '=?UTF-8?B?' . base64_encode($subject) . '?=', implode("\r\n", $lines), implode("\r\n", $headers), '-f' . FROM_EMAIL);
if (!$ok) {
    back_with_error();
}
header('Location: /thank-you/', true, 303);
exit;
