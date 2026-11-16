import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The Slack calls the board makes, through the same path dori-slack-reply uses: the bot token stays on the ssh host
 * (~/.hermes/.env there) and never reaches this machine. A read runs one small Python script on that host per call; a
 * send runs DORI_HOME/bin/dori-slack-reply with the text on stdin. Every answer is a status, a parsed body and the
 * seconds to wait after a 429 (0 otherwise). `dori.users` is not a Slack method: it returns the host's
 * SLACK_ALLOWED_USERS, the operator's own Slack users.
 */
export type SlackAnswer = { status: number; body: unknown; retryAfter: number };
export type SlackCall = (method: string, params?: Record<string, string>) => Promise<SlackAnswer>;
export type SlackReply = (channel: string, thread: string, text: string) => Promise<string | null>;

const TIMEOUT_MS = 20_000;
const SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];

const REMOTE = `import base64,json,os,urllib.request,urllib.parse,urllib.error
q=json.loads(base64.b64decode("@REQ@"))
env={}
for l in open(os.path.expanduser("~/.hermes/.env")):
  l=l.strip()
  if "=" in l and not l.startswith("#"):
    k,v=l.split("=",1);env[k.strip()]=v.strip().strip("'\\"")
def out(s,b,w=0):print(json.dumps({"status":s,"body":b,"retryAfter":w}))
if q["method"]=="dori.users":
  out(200,{"ok":True,"users":[u.strip() for u in env.get("SLACK_ALLOWED_USERS","").split(",") if u.strip()]})
else:
  r=urllib.request.Request("https://slack.com/api/"+q["method"]+"?"+urllib.parse.urlencode(q["params"]),headers={"Authorization":"Bearer "+env.get("SLACK_BOT_TOKEN","")})
  try:
    with urllib.request.urlopen(r,timeout=10) as res:out(res.status,json.load(res))
  except urllib.error.HTTPError as e:out(e.code,None,int(e.headers.get("Retry-After") or 30))
`;

async function run(argv: string[], stdin: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, {
    env: process.env,
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "ignore",
    timeout: TIMEOUT_MS,
  });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out };
}

/** DORI_HOME/bin/dori-slack-reply, the board's sign that Slack is set up here; null when it is missing. */
export function slackReplyPath(home: string): string | null {
  const path = join(home, "bin", "dori-slack-reply");
  return existsSync(path) ? path : null;
}

export function slackCall(host = "ubuntu"): SlackCall {
  return async (method, params = {}) => {
    if (!/^[a-z]+(\.[a-zA-Z]+)+$/.test(method)) throw new Error("bad Slack method");
    const req = Buffer.from(JSON.stringify({ method, params })).toString("base64");
    const r = await run([...SSH, host, "python3", "-"], REMOTE.replace("@REQ@", req));
    if (r.code !== 0) throw new Error(`ssh exit ${r.code}`);
    return JSON.parse(r.out) as SlackAnswer;
  };
}

/** Posts through dori-slack-reply; the new message's ts, or null when Slack refused it. */
export function slackReply(path: string): SlackReply {
  return async (channel, thread, text) => {
    const r = await run([path, channel, thread], text);
    const m = /^OK (\S+)/m.exec(r.out);
    return r.code === 0 && m ? m[1]! : null;
  };
}
