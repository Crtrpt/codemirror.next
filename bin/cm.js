#!/usr/bin/env node

// NOTE: Don't require anything from node_modules here, since the
// install script has to be able to run _before_ that exists.
const child = require("child_process"), fs = require("fs"), fsp = fs.promises, path = require("path"), {join} = path

let root = join(__dirname, "..")

class Pkg {
  constructor(name) {
    this.name = name
    this.dir = join(root, name)
    this.main = null
    if (name != "legacy-modes") {
      let files = fs.readdirSync(join(this.dir, "src")).filter(f => /^[^.]+\.ts$/.test(f))
      let main = files.length == 1 ? files[0] : files.includes("index.ts") ? "index.ts"
          : files.includes(name.replace(/^(theme-|lang-)/, "") + ".ts") ? name.replace(/^(theme-|lang-)/, "") + ".ts" : null
      if (!main) throw new Error("Couldn't find a main script for " + name)
      this.main = join(this.dir, "src", main)
    }
  }
}

const core = [
  "state",
  "text",
  "view",
  "commands",
  "history",
  "collab",
  "gutter",
  "rangeset",
  "language",
  "language-data",
  "fold",
  "matchbrackets",
  "closebrackets",
  "panel",
  "tooltip",
  "search",
  "lint",
  "highlight",
  "stream-parser",
  "autocomplete",
  "comment",
  "rectangular-selection",
  "basic-setup"
].map(n => new Pkg(n))
let nonCore = [
  "lang-javascript",
  "lang-java",
  "lang-json",
  "lang-cpp",
  "lang-python",
  "lang-css",
  "lang-html",
  "lang-sql",
  "lang-rust",
  "lang-xml",
  "lang-markdown",
  "legacy-modes",
  "theme-one-dark"
].map(n => new Pkg(n))

let packages = core.concat(nonCore), buildPackages = packages.filter(p => p.main)

let packageNames = Object.create(null)
for (let p of packages) packageNames[p.name] = p

function start() {
  let command = process.argv[2]
  if (command && !["install", "--help"].includes(command)) assertInstalled()
  let args = process.argv.slice(3)
  let cmdFn = {
    packages: listPackages,
    build,
    devserver,
    release,
    install,
    commit,
    push,
    run: runCmd,
    "--help": () => help(0)
  }[command]
  if (!cmdFn || cmdFn.length > args.length) help(1)
  new Promise(r => r(cmdFn.apply(null, args))).catch(e => error(e))
}

function help(status) {
  console.log(`Usage:
  cm install [--ssh]      Clone and symlink the packages, install dependencies, build
  cm packages             Emit a list of all pkg names
  cm build                Build the bundle files
  cm devserver            Start a dev server on port 8090
  cm release              Create commits to tag a release
  cm commit <args>        Run git commit in all packages that have changes
  cm push                 Run git push in packages that have new commits
  cm run <command>        Run the given command in each of the package dirs
  cm --help`)
  process.exit(status)
}

function error(err) {
  console.error(err)
  process.exit(1)
}

function run(cmd, args, wd = root) {
  return child.execFileSync(cmd, args, {cwd: wd, encoding: "utf8", stdio: ["ignore", "pipe", process.stderr]})
}

function assertInstalled() {
  for (let p of packages) {
    if (!fs.existsSync(p.dir)) {
      console.error(`module ${p.name} is missing. Did you forget to run 'cm install'?`)
      process.exit(1)
    }
  }
}

function install(arg = null) {
  let base = arg == "--ssh" ? "git@github.com:codemirror/" : "https://github.com/codemirror/"
  if (arg && arg != "--ssh") help(1)

  for (let pkg of packages) {
    if (fs.existsSync(pkg.dir)) {
      console.warn(`Skipping cloning of ${pkg.name} (directory exists)`)
    } else {
      let origin = base + pkg.name + ".git"
      run("git", ["clone", origin, pkg.dir])
    }
  }

  console.log("Running yarn install")
  run("yarn", ["install"])
  console.log("Building modules")
  build()
}


function listPackages() {
  console.log(packages.map(p => p.name).join("\n"))
}

async function runRollup(configs) {
  for (let config of Array.isArray(configs) ? configs : [configs]) {
    let bundle = await require("rollup").rollup(config)
    let result = await bundle.generate(config.output)
    let dir = path.dirname(config.output.file)
    await fsp.mkdir(dir, {recursive: true}).catch(() => null)
    for (let file of result.output) {
      await fsp.writeFile(join(dir, file.fileName), file.code || file.source)
      if (file.map)
        await fsp.writeFile(join(dir, file.fileName + ".map"), file.map.toString())
    }
  }
}

function external(id) { return id != "tslib" && !/^(\.?\/|\w:)/.test(id) }

function rollupConfig(pkg) {
  return {
    input: pkg.main.replace(/\.ts$/, ".js"),
    external,
    output: {
      format: "esm",
      file: join(pkg.dir, "dist", "index.js"),
      sourcemap: true,
      externalLiveBindings: false
    },
    plugins: [require("lezer-generator/rollup").lezer()]
  }
}

function rollupDeclConfig(pkg) {
  return {
    input: pkg.main.replace(/\.ts$/, ".d.ts"),
    external,
    output: {
      format: "esm",
      file: join(pkg.dir, "dist", "index.d.ts")
    },
    plugins: [require("rollup-plugin-dts").default()],
    onwarn(warning, warn) {
      if (warning.code != "CIRCULAR_DEPENDENCY" && warning.code != "UNUSED_EXTERNAL_IMPORT") warn(warning)
    }
  }
}

async function build() {
  console.info("Running TypeScript compiler...")
  let t0 = Date.now()
  tsBuild()
  console.info(`Done in ${((Date.now() - t0) / 1000).toFixed(2)}s`)
  console.info("Building bundles...")
  t0 = Date.now()
  await runRollup(buildPackages.map(rollupConfig).concat(buildPackages.map(rollupDeclConfig)))
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(2)}s`)
}

function startServer() {
  let serve = join(root, "demo")
  let moduleserver = new (require("esmoduleserve/moduleserver"))({root: serve, maxDepth: 2})
  let serveStatic = require("serve-static")(serve)
  require("http").createServer((req, resp) => {
    moduleserver.handleRequest(req, resp) || serveStatic(req, resp, err => {
      resp.statusCode = 404
      resp.end('Not found')
    })
  }).listen(8090, process.env.OPEN ? undefined : "127.0.0.1")
  console.log("Dev server listening on 8090")
}

function customResolve(ts, host) {
  // TypeScript's default behavior will look at the types field in the
  // package.json files and treat sibling packages as external,
  // duplicating a bunch of type information. This overrides
  // resolution to handle sibling packages specially.
  host.resolveModuleNames = function(names, parent, _c, _r, options) {
    return names.map(name => {
      let cm = /^@codemirror\/(\w+)$/.exec(name)
      let pkg = cm && packageNames[cm[1]]
      if (pkg) return {resolvedFileName: pkg.main, isExternalLibraryImport: false}
      return ts.resolveModuleName(name, parent, options, host).resolvedModule
    })
  }
  return host
}

function tsFormatHost(ts) {
  return {
    getCanonicalFileName: path => path,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => "\n"
  }
}

function tsWatch() {
  const ts = require("typescript")
  ts.createWatchProgram(customResolve(ts, ts.createWatchCompilerHost(
    join(root, "tsconfig.json"),
    {},
    ts.sys,
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    diag => console.error(ts.formatDiagnostic(diag, tsFormatHost(ts))),
    diag => console.info(ts.flattenDiagnosticMessageText(diag.messageText, "\n"))
  )))
}

function tsBuild() {
  const ts = require("typescript")
  let conf = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, ts.sys)
  let program = ts.createProgram(conf.fileNames, conf.options, customResolve(ts, ts.createCompilerHost(conf.options)))
  let emitResult = program.emit()

  for (let diag of ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics))
    console.error(ts.formatDiagnostic(diag, tsFormatHost(ts)))

  if (emitResult.emitSkipped) error("TS build failed")
}

function devserver() {
  tsWatch()
  console.log("Watching...")
  for (let pkg of buildPackages) {
    let watcher = require("rollup").watch(rollupConfig(pkg))
    watcher.on("event", event => {
      if (event.code == "START") console.info("Start bundling " + pkg.name + "...")
      else if (event.code == "END") console.info("Finished bundling " + pkg.name)
      else if (event.code == "ERROR") console.error(`Bundling error (${pkg.name}): ${event.error}`)
      else if (event.code == "BUNDLE_END") event.result.close()
    })
    let declWatcher = require("rollup").watch(rollupDeclConfig(pkg))
    declWatcher.on("event", event => {
      if (event.code == "ERROR") console.error(`Decl bundling error (${pkg.name}): ${event.error}`)
      else if (event.code == "BUNDLE_END") event.result.close()
    })
  }
  startServer()
}

function changelog(since) {
  let commits = run("git", ["log", "--format=%B", "--reverse", since + "..master"])
  let result = {fix: [], feature: [], breaking: []}
  let re = /\n\r?\n(BREAKING|FIX|FEATURE):\s*([^]*?)(?=\r?\n\r?\n|\r?\n?$)/g, match
  while (match = re.exec(commits)) result[match[1].toLowerCase()].push(match[2].replace(/\r?\n/g, " "))
  return result
}

function bumpVersion(version, changes) {
  let [major, minor, patch] = version.split(".")
  if (changes.breaking.length && major != "0") return `${Number(major) + 1}.0.0`
  if (changes.feature.length || changes.breaking.length) return `${major}.${Number(minor) + 1}.0`
  if (changes.fix.length) return `${major}.${minor}.${Number(patch) + 1}`
  throw new Error("No new release notes!")
}

function releaseNotes(changes, version) {
  let pad = n => n < 10 ? "0" + n : n
  let d = new Date, date = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())

  let types = {breaking: "Breaking changes", fix: "Bug fixes", feature: "New features"}

  let refTarget = "https://codemirror.net/6/docs/ref/"
  let head = `## ${version} (${date})\n\n`, body = ""
  for (let type in types) {
    let messages = changes[type]
    if (messages.length) body += `### ${types[type]}\n\n`
    messages.forEach(message => body += message.replace(/\]\(##/g, "](" + refTarget + "#") + "\n\n")
  }
  return {head, body}
}

function setModuleVersion(version) {
  fs.writeFileSync(packageFile, fs.readFileSync(packageFile, "utf8").replace(/"version":\s*".*?"/, `"version": "${version}"`))
}

function release(...args) {
  let currentVersion = packageJSON.version
  let changes = changelog(currentVersion)
  let newVersion = bumpVersion(currentVersion, changes)
  console.log(`Creating @codemirror/next ${newVersion}`)

  let notes = releaseNotes(changes, newVersion)
  if (args.indexOf("--edit") > -1) {
    let noteFile = join(root, "notes.txt")
    fs.writeFileSync(noteFile, notes.head + notes.body)
    run(process.env.EDITOR || emacs, [noteFile])
    let edited = fs.readFileSync(noteFile)
    fs.unlinkSync(noteFile)
    if (!/\S/.test(edited)) process.exit(0)
    let split = /^(.*)\n+([^]*)/.exec(edited)
    notes = {head: split[1] + "\n\n", body: split[2]}
  }

  setModuleVersion(newVersion)
  let log = join(root, "CHANGELOG.md")
  fs.writeFileSync(log, notes.head + notes.body + fs.readFileSync(log, "utf8"))
  run("git", ["add", "package.json"])
  run("git", ["add", "CHANGELOG.md"])
  run("git", ["commit", "-m", `Mark version ${newVersion}`])
  run("git", ["tag", newVersion, "-m", `Version ${newVersion}\n\n${notes.body}`, "--cleanup=verbatim"])
}

function commit(...args) {
  for (pkg of packages) {
    if (run("git", ["diff"], pkg.dir) || run("git", ["diff", "--cached"], pkg.dir))
      console.log(pkg.name + ":\n" + run("git", ["commit"].concat(args), pkg.dir))
  }
}

function push() {
  for (let pkg of packages) {
    if (/\bahead\b/.test(run("git", ["status", "-sb"], pkg.dir)))
      run("git", ["push"], pkg.dir)
  }
}

function runCmd(cmd, ...args) {
  for (let pkg of packages) {
    console.log(pkg.name + ":")
    try {
      console.log(run(cmd, args, pkg.dir))
    } catch (e) {
      console.log(e.toString())
      process.exit(1)
    }
  }
}

start()
