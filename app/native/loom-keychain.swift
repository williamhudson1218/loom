// loom-keychain: read, write and delete one generic-password item in the login
// Keychain. Loom keeps its Slack token here instead of in a file under ~/.loom.
//
//   loom-keychain get    --service S --account A   -> secret on stdout (no newline), exit 0
//   loom-keychain set    --service S --account A   <- secret on stdin, exit 0
//   loom-keychain delete --service S --account A   -> exit 0 (also when there was nothing to delete)
//   loom-keychain has    --service S --account A   -> exit 0 if present, 44 if not (never prints the secret)
//
// The secret only ever travels over stdin/stdout. It is never an argument, so it
// cannot show up in `ps` (which is why this exists instead of
// `security add-generic-password -w <secret>`). Errors go to stderr and never
// include the secret.
//
// Exit codes: 0 ok, 2 usage, 44 not found, 1 any other Keychain error.
import Foundation
import Security

let NOT_FOUND: Int32 = 44

func fail(_ msg: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

func describe(_ status: OSStatus) -> String {
  let text = (SecCopyErrorMessageString(status, nil) as String?) ?? "unknown"
  return "keychain error \(status): \(text)"
}

let args = Array(CommandLine.arguments.dropFirst())
guard let op = args.first, ["get", "set", "delete", "has"].contains(op) else {
  fail("usage: loom-keychain get|set|delete|has --service S --account A", 2)
}

var service = ""
var account = ""
var i = 1
while i < args.count {
  let flag = args[i]
  guard i + 1 < args.count else { fail("missing value for \(flag)", 2) }
  switch flag {
  case "--service": service = args[i + 1]
  case "--account": account = args[i + 1]
  default: fail("unknown flag \(flag)", 2)
  }
  i += 2
}
if service.isEmpty || account.isEmpty { fail("--service and --account are required", 2) }

let base: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
]

switch op {
case "get", "has":
  var q = base
  q[kSecMatchLimit as String] = kSecMatchLimitOne
  q[kSecReturnData as String] = op == "get"
  var out: CFTypeRef?
  let st = SecItemCopyMatching(q as CFDictionary, &out)
  if st == errSecItemNotFound { exit(NOT_FOUND) }
  if st != errSecSuccess { fail(describe(st)) }
  if op == "get" {
    guard let data = out as? Data else { fail("keychain item has no data") }
    FileHandle.standardOutput.write(data)
  }
  exit(0)

case "set":
  var data = FileHandle.standardInput.readDataToEndOfFile()
  // A trailing newline from `echo` or a paste is not part of the secret.
  while let last = data.last, last == 0x0A || last == 0x0D { data.removeLast() }
  if data.isEmpty { fail("no secret on stdin", 2) }
  let upd = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
  if upd == errSecSuccess { exit(0) }
  if upd != errSecItemNotFound { fail(describe(upd)) }
  var add = base
  add[kSecValueData as String] = data
  add[kSecAttrLabel as String] = service
  add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
  let st = SecItemAdd(add as CFDictionary, nil)
  if st != errSecSuccess { fail(describe(st)) }
  exit(0)

case "delete":
  let st = SecItemDelete(base as CFDictionary)
  if st != errSecSuccess && st != errSecItemNotFound { fail(describe(st)) }
  exit(0)

default:
  fail("unreachable", 2)
}
