const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const readmePath = path.join(repoRoot, "README.md");
const startMarker = "<!-- heartbeat:start -->";
const endMarker = "<!-- heartbeat:end -->";

function runGit(args, options = {}) {
  const output = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"]
  });

  return typeof output === "string" ? output.trim() : "";
}

function gitConfig(key, value) {
  try {
    runGit(["config", key, value]);
  } catch (error) {
    throw new Error(`Failed to set git config ${key}: ${error.stderr || error.message}`);
  }
}

function getCurrentBranch() {
  return (
    process.env.GIT_BRANCH ||
    process.env.RENDER_GIT_BRANCH ||
    runGit(["branch", "--show-current"]) ||
    "master"
  );
}

function getInstanceName() {
  return (
    process.env.INSTANCE_NAME ||
    process.env.RENDER_SERVICE_NAME ||
    process.env.RENDER_INSTANCE_ID ||
    os.hostname()
  );
}

function getIsoTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildHeartbeatBlock(existingReadme, timestamp, instanceName) {
  const previousEntries = [];
  const entryPattern = /^- `([^`]+)` - instance: `([^`]+)` - host: `([^`]+)`$/gm;
  let match;

  while ((match = entryPattern.exec(existingReadme)) !== null) {
    previousEntries.push({
      timestamp: match[1],
      instance: match[2],
      host: match[3]
    });
  }

  const host = os.hostname();
  const entries = [
    { timestamp, instance: instanceName, host },
    ...previousEntries.filter((entry) => entry.timestamp !== timestamp)
  ].slice(0, 30);

  const logLines = entries
    .map((entry) => `- \`${entry.timestamp}\` - instance: \`${entry.instance}\` - host: \`${entry.host}\``)
    .join("\n");

  return `${startMarker}
## Heartbeat

Last update: \`${timestamp}\`

Instance: \`${instanceName}\`

Host: \`${host}\`

Recent check-ins:

${logLines}
${endMarker}`;
}

function updateReadme(timestamp, instanceName) {
  const fallbackReadme = `# GitHub Ping Heartbeat

This README is updated by a scheduled job with the latest run time and the instance name.

${startMarker}
${endMarker}
`;

  const existingReadme = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, "utf8")
    : fallbackReadme;
  const block = buildHeartbeatBlock(existingReadme, timestamp, instanceName);

  let nextReadme;
  if (existingReadme.includes(startMarker) && existingReadme.includes(endMarker)) {
    const startIndex = existingReadme.indexOf(startMarker);
    const endIndex = existingReadme.indexOf(endMarker) + endMarker.length;
    nextReadme = `${existingReadme.slice(0, startIndex)}${block}${existingReadme.slice(endIndex)}`;
  } else {
    nextReadme = `${existingReadme.trimEnd()}

${block}
`;
  }

  fs.writeFileSync(readmePath, nextReadme);
}

function configurePushRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY || parseRepositoryFromOrigin();
  if (!repository) {
    throw new Error("GITHUB_TOKEN is set, but the GitHub repository could not be detected. Set GITHUB_REPOSITORY=owner/repo.");
  }

  runGit(["remote", "set-url", "origin", `https://x-access-token:${token}@github.com/${repository}.git`]);
}

function syncBranch(branch) {
  try {
    runGit(["remote", "get-url", "origin"]);
  } catch {
    return;
  }

  runGit(["fetch", "origin", branch], { stdio: "inherit" });
  runGit(["checkout", "-B", branch, "FETCH_HEAD"], { stdio: "inherit" });
}

function parseRepositoryFromOrigin() {
  try {
    const origin = runGit(["remote", "get-url", "origin"]);
    const httpsMatch = origin.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
    return httpsMatch ? httpsMatch[1] : "";
  } catch {
    return "";
  }
}

function hasReadmeChanges() {
  return runGit(["status", "--porcelain", "--", "README.md"]) !== "";
}

function main() {
  const timestamp = getIsoTimestamp();
  const instanceName = getInstanceName();
  const branch = getCurrentBranch();

  gitConfig("user.name", process.env.GIT_AUTHOR_NAME || "README Heartbeat Bot");
  gitConfig("user.email", process.env.GIT_AUTHOR_EMAIL || "readme-heartbeat@example.com");
  configurePushRemote();
  syncBranch(branch);

  updateReadme(timestamp, instanceName);

  if (!hasReadmeChanges()) {
    console.log("README.md already up to date.");
    return;
  }

  runGit(["add", "README.md"]);
  runGit(["commit", "-m", `chore: update heartbeat ${timestamp}`], { stdio: "inherit" });
  runGit(["push", "origin", `HEAD:${branch}`], { stdio: "inherit" });
  console.log(`Heartbeat committed and pushed to ${branch}.`);
}

main();
