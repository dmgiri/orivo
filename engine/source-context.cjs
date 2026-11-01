'use strict';

// Redact content before it crosses the local tracing engine boundary. Keep line
// breaks intact so source locations remain useful; hashes are over original bytes.
function redact(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/g, match => '[REDACTED KEY MATERIAL]' + '\n'.repeat((match.match(/\n/g) || []).length))
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:["']?)(?:password|passwd|pwd|secret|client_secret|api[_-]?key|token|access[_-]?token|refresh[_-]?token|authorization|cookie|session[_-]?key|connection[_-]?string|database[_-]?url)(?:["']?)\s*[:=]\s*)(["'`])[^\r\n]*?\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)(?!\[REDACTED\])[^\s,;"'`]+/gi, '$1[REDACTED]');
}

module.exports = {redact};
