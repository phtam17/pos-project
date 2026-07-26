import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const scripts = ["dev:api", "dev:register"];
const children = scripts.map((script) =>
  spawn(npmCommand, ["run", script], {
    stdio: "inherit",
  }),
);

let stopping = false;

function stop(signal, exitCode) {
  if (stopping) {
    return;
  }

  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }

  const forceExit = setTimeout(() => process.exit(exitCode), 5_000);
  forceExit.unref();

  Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", resolve);
        }),
    ),
  ).then(() => process.exit(exitCode));
}

for (const child of children) {
  child.once("error", (error) => {
    console.error(`Unable to start development process: ${error.message}`);
    stop("SIGTERM", 1);
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      console.error(`A development process stopped with ${reason}.`);
      stop("SIGTERM", code ?? 1);
    }
  });
}

process.once("SIGINT", () => stop("SIGINT", 130));
process.once("SIGTERM", () => stop("SIGTERM", 143));
