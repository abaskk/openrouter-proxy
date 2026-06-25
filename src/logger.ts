export const CLR = {
  reset: "\x1b[0m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};

const LOG_ICONS: Record<string, string> = {
  info: `${CLR.green}*${CLR.reset}`,
  warn: `${CLR.yellow}*${CLR.reset}`,
  error: `${CLR.red}*${CLR.reset}`,
  proxy: `${CLR.cyan}->${CLR.reset}`,
  sse: `${CLR.magenta}~${CLR.reset}`,
  ws: `${CLR.blue}o${CLR.reset}`,
  image: `${CLR.yellow}#${CLR.reset}`,
};

export type LogLevel = keyof typeof LOG_ICONS;

export function log(level: LogLevel, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  const icon = LOG_ICONS[level] || " ";
  console.log(`${CLR.dim}${ts}${CLR.reset} ${icon} ${msg}`, ...(extra ? [extra] : []));
}
