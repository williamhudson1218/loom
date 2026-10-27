// slack-ax: reads which Slack message is at a screen point, via macOS
// Accessibility. Long-lived: one JSON request per stdin line, one JSON reply per
// stdout line, so Loom's pick overlay can hit-test as the mouse moves without a
// spawn per move. Read-only toward Slack: it sets AXManualAccessibility (which
// makes Slack's Electron renderer expose its DOM tree) and reads attributes.
//
//   {"op":"trust","prompt":false}      -> {"trusted":true}
//   {"op":"hit","x":900,"y":400}       -> {"ok":true,"url":"…","rect":{x,y,w,h},"inThread":false,"rootUrl":null}
//                                         {"ok":false,"reason":"not_message"|"covered"|"no_slack"|"untrusted"}
//     "root":true also finds the open thread pane's root when a reply lacks thread_ts;
//     "anyWindow":true skips the "is Slack the window on top here" check (tests).
//   {"op":"list"}                      -> {"ok":true,"messages":[{url,rect,inThread}…]}  (diagnostics/tests)
//
// Coordinates are global screen points, top-left origin: the same space as
// Electron's screen API and AX positions. A message is a `c-virtual_list__item`
// in Slack's DOM, and its permalink is the AXURL of its `c-timestamp` link.
import Cocoa
import ApplicationServices

let SLACK = "com.tinyspeck.slackmacgap"

func attr(_ e: AXUIElement, _ k: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ k: String) -> String { (attr(e, k) as? String) ?? "" }
func classes(_ e: AXUIElement) -> [String] { (attr(e, "AXDOMClassList") as? [String]) ?? [] }
func parent(_ e: AXUIElement) -> AXUIElement? {
  guard let p = attr(e, kAXParentAttribute) else { return nil }
  return (p as! AXUIElement)
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func rect(_ e: AXUIElement) -> [String: Double] {
  var pos = CGPoint.zero, size = CGSize.zero
  if let p = attr(e, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &pos) }
  if let z = attr(e, kAXSizeAttribute) { AXValueGetValue(z as! AXValue, .cgSize, &size) }
  return ["x": Double(pos.x), "y": Double(pos.y), "w": Double(size.width), "h": Double(size.height)]
}

var childPid: pid_t = 0
var cachedPid: pid_t = 0
var cachedApp: AXUIElement?
func slackApp() -> AXUIElement? {
  guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: SLACK).first else { return nil }
  if running.processIdentifier != cachedPid || cachedApp == nil {
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 0.5)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    cachedPid = running.processIdentifier
    cachedApp = app
  }
  return cachedApp
}

/// The message permalink inside a message container: its timestamp link.
/// Body links can point at other messages, so only `c-timestamp` counts.
func timestampURL(_ e: AXUIElement, _ depth: Int = 0) -> String? {
  if depth > 30 { return nil }
  if str(e, "AXRole") == "AXLink", classes(e).contains("c-timestamp"),
     let u = attr(e, kAXURLAttribute) as? URL, u.absoluteString.contains("/archives/") {
    return u.absoluteString
  }
  for c in children(e) { if let u = timestampURL(c, depth + 1) { return u } }
  return nil
}

func isItem(_ e: AXUIElement) -> Bool { classes(e).contains("c-virtual_list__item") }
func isThreadList(_ list: AXUIElement?) -> Bool {
  guard let l = list else { return false }
  return str(l, "AXDescription").hasPrefix("Thread")
}

/// The open thread pane's root: the first item in its list whose permalink has
/// no thread_ts (replies carry one, the root does not). nil when scrolled away.
func threadRoot(_ list: AXUIElement) -> String? {
  for item in children(list) where isItem(item) {
    if let u = timestampURL(item), !u.contains("thread_ts=") { return u }
  }
  return nil
}

func describe(_ item: AXUIElement, _ list: AXUIElement?, withRoot: Bool) -> [String: Any]? {
  guard let url = timestampURL(item) else { return nil }
  let inThread = isThreadList(list)
  var out: [String: Any] = ["url": url, "rect": rect(item), "inThread": inThread, "rootUrl": NSNull()]
  if withRoot, inThread, !url.contains("thread_ts="), let l = list, let root = threadRoot(l) { out["rootUrl"] = root }
  return out
}

/// Is Slack the frontmost ordinary window at this point? Our parent's windows
/// (the pick overlay) are skipped. Owner pids and bounds need no extra grant.
func slackOnTop(_ x: Double, _ y: Double) -> Bool {
  guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return true }
  let me = getppid()
  for w in info {
    guard (w[kCGWindowLayer as String] as? Int) == 0,
          let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != me,
          let b = w[kCGWindowBounds as String] as? [String: Double] else { continue }
    let r = ["x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0]
    if contains(r, x, y) { return pid == cachedPid }
  }
  return false
}

func hit(_ x: Double, _ y: Double, withRoot: Bool, anyWindow: Bool = false) -> [String: Any] {
  if !AXIsProcessTrusted() { return ["ok": false, "reason": "untrusted"] }
  guard let app = slackApp() else { return ["ok": false, "reason": "no_slack"] }
  // AX answers for Slack's own layout even where another window covers it, so a
  // point is only Slack's when Slack's window is the frontmost one there.
  if !anyWindow, !slackOnTop(x, y) { return ["ok": false, "reason": "covered"] }
  var el: AXUIElement?
  guard AXUIElementCopyElementAtPosition(app, Float(x), Float(y), &el) == .success, var cur = el else {
    return ["ok": false, "reason": "not_message"]
  }
  let start = cur
  var item: AXUIElement?
  for _ in 0..<40 {
    if isItem(cur) { item = cur; break }
    if str(cur, "AXRole") == "AXWebArea" { break }
    guard let p = parent(cur) else { break }
    cur = p
  }
  // The channel view's list is screen-reader-only (a 1x0 box), so Chromium's
  // hit-test stops at the pane around it and never reaches an item. Look down
  // from there instead, for the item whose own box holds the point.
  if item == nil, str(start, "AXRole") != "AXWebArea" { item = itemBelow(start, x, y, 0) }
  if let it = item, let d = describe(it, parent(it), withRoot: withRoot) { return ["ok": true].merging(d) { a, _ in a } }
  // No item, or one with no permalink: a date divider or "new messages" line.
  return ["ok": false, "reason": "not_message"]
}

func contains(_ r: [String: Double], _ x: Double, _ y: Double) -> Bool {
  x >= r["x"]! && x < r["x"]! + r["w"]! && y >= r["y"]! && y < r["y"]! + r["h"]!
}

func itemBelow(_ e: AXUIElement, _ x: Double, _ y: Double, _ depth: Int) -> AXUIElement? {
  if depth > 6 { return nil }
  for c in children(e) {
    if isItem(c) {
      if contains(rect(c), x, y) { return c }
      continue // never descend into another message
    }
    if let hit = itemBelow(c, x, y, depth + 1) { return hit }
  }
  return nil
}

func list() -> [String: Any] {
  if !AXIsProcessTrusted() { return ["ok": false, "reason": "untrusted"] }
  guard let app = slackApp() else { return ["ok": false, "reason": "no_slack"] }
  var found: [[String: Any]] = []
  func walk(_ e: AXUIElement, _ depth: Int) {
    if depth > 80 || found.count > 200 { return }
    if isItem(e) {
      if let d = describe(e, parent(e), withRoot: true) { found.append(d) }
      return
    }
    for c in children(e) { walk(c, depth + 1) }
  }
  walk(app, 0)
  return ["ok": true, "messages": found]
}

func reply(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
    print(s)
    fflush(stdout)
  }
}

// ---------- run as our own responsible process ----------
//
// macOS charges a child's Accessibility use to its "responsible" process, the
// app that launched it: here Loom.app. tccd validates that app's signature on
// disk, and an electron-builder bundle with no identity fails static validation
// (the Electron ad-hoc seal no longer matches the resources), so Loom passes
// AXIsProcessTrusted in-process while this helper is refused. So the helper
// re-launches itself with responsibility disclaimed: it becomes its own
// responsible process, gets its own "slack-ax" row in Privacy & Security ›
// Accessibility, and that grant holds as long as this binary is unchanged.
// stdin/stdout/stderr are inherited, so the parent just waits and relays the
// exit status; the child leaves when its parent does.
let DISCLAIMED = "LOOM_SLACK_AX_DISCLAIMED"
typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
if getenv(DISCLAIMED) == nil, let sym = dlsym(dlopen(nil, RTLD_NOW), "responsibility_spawnattrs_setdisclaim") {
  let setDisclaim = unsafeBitCast(sym, to: SetDisclaim.self)
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  _ = setDisclaim(&attr, 1)
  setenv(DISCLAIMED, "1", 1)
  let path = CommandLine.arguments[0]
  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  var child: pid_t = 0
  let rc = posix_spawn(&child, path, nil, &attr, &argv, environ)
  if rc == 0 {
    for sig in [SIGTERM, SIGINT, SIGHUP] { signal(sig) { s in kill(childPid, s); exit(0) } }
    childPid = child
    var status: Int32 = 0
    while waitpid(child, &status, 0) == -1 && errno == EINTR {}
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
  }
  // Could not re-launch: carry on undisclaimed rather than not at all.
  fputs("slack-ax: disclaimed spawn failed (\(rc)); running attributed to the parent\n", stderr)
} else if getenv(DISCLAIMED) != nil {
  // Our launcher is the process Loom holds; if it goes, so do we.
  let launcher = getppid()
  Thread.detachNewThread {
    while true { sleep(1); if getppid() != launcher { exit(0) } }
  }
}

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
    reply(["ok": false, "reason": "bad_request"]); continue
  }
  switch req["op"] as? String {
  case "trust":
    let prompt = (req["prompt"] as? Bool) ?? false
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    reply(["trusted": AXIsProcessTrustedWithOptions(opts)])
  case "hit":
    reply(hit((req["x"] as? Double) ?? -1, (req["y"] as? Double) ?? -1, withRoot: (req["root"] as? Bool) ?? false,
              anyWindow: (req["anyWindow"] as? Bool) ?? false))
  case "list":
    reply(list())
  default:
    reply(["ok": false, "reason": "bad_request"])
  }
}
