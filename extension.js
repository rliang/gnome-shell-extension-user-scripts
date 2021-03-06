const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const ShellJS = imports.gi.ShellJS;
const Main = imports.ui.main;

const LocalDir = scriptDir(GLib.get_user_data_dir());
const RemoteDir = scriptDir(GLib.get_user_cache_dir());

let Scripts;

function isFunction(fn) {
  return typeof fn === 'function';
}

function isAbsoluteUri(str) {
  return new RegExp('^(?:/|.+://)').test(str);
}

// (scheme://a/b/c, d) -> scheme://a/b/d
function uriResolveNeighbor(uri, neighbor) {
  return Gio.file_new_for_uri(uri).get_parent()
  .resolve_relative_path(neighbor).get_uri();
}

// throws on failure
function fileEnsureDir(file) {
  let type = file.query_file_type(0, null);
  if (type !== Gio.FileType.DIRECTORY)
    file.make_directory_with_parents(null);
}

function fileLoad(file, cb, err) {
  file.load_contents_async(null, function(obj, res) {
    let data;
    try {
      [,data] = obj.load_contents_finish(res);
    } catch (e) {
      err(e);
      return;
    }
    cb(data);
  });
}

function fileWrite(file, data, cb, err) {
  file.replace_contents_bytes_async(data, null, false, 0, null, (obj, res) => {
    try {
      obj.replace_contents_finish(res);
    } catch (e) {
      err(e);
      return;
    }
    cb();
  });
}

// topological sort
function tsort(graph) {
  let done = {}, temp = {}, result = [];
  function visit(node) {
    if (done[node] || temp[node]) return;
    temp[node] = true;
    (graph[node] || []).forEach(visit);
    done[node] = true;
    temp[node] = false;
    result.push(node);
  }
  for (let node in graph) visit(node);
  return result;
}

// returns {sname: stateObj}
function loadDirectoryScripts(path) {
  global._importer = {};
  ShellJS.add_extension_importer('global._importer', 'imports', path);
  let imports = global._importer.imports;
  delete global._importer;
  return imports;
}

function format(str, ...args) {
  for (let a of args)
    str = str.replace(/{}/, a);
  return str;
}

function errorWhen(e, msg, ...args) {
  if (msg)
    e.name = format('{} when {}', (e.name || 'Error'),
                    format.apply(null, [msg].concat(args)));
  return e;
}

function notify() {
  Main.notify(format.apply(null, arguments));
}

function notifyError(e) {
  e = errorWhen.apply(null, arguments);
  Main.notifyError(e.name, format('{}: \n{}', e.message, e.stack));
}

// where to store scripts for a given base path
function scriptDir(path) {
  return Gio.file_new_for_path(path)
  .get_child('gnome-shell').get_child('userscripts');
}

function uriToScriptname(uri) {
  return GLib.uri_escape_string(uri, null, true);
}

function scriptNameToUri(name) {
  return GLib.uri_unescape_string(name, null);
}

// scripts are always loaded named as their filenames without extension
function scriptNameToFilename(sname) {
  return sname + '.js';
}

function scriptIsLocal(sname) {
  return !isAbsoluteUri(scriptNameToUri(sname));
}

function scriptIsDepended(dname) {
  for (let sname in Scripts) {
    let {depends} = Scripts[sname];
    if (depends && dname in depends) return true;
  }
  return false;
}

function scriptResolveDependencyUri(sname, uri) {
  return isAbsoluteUri(uri) || scriptIsLocal(sname) ? uri :
    uriResolveNeighbor(scriptNameToUri(sname), uri) + '.js';
}

// constructs {sname: {depends: {dname: {alias, uri}}
function loadScriptDependencies() {
  for (let sname in Scripts) {
    let scr = Scripts[sname];
    if (scr.depends) continue;
    scr.depends = {};
    if (!isFunction(scr.stateObj.depends)) continue;
    let obj = scr.stateObj.depends();
    for (let alias in obj) {
      let uri = scriptResolveDependencyUri(sname, obj[alias]);
      let dname = uriToScriptname(uri);
      scr.depends[dname] = {alias: alias, uri: uri};
    }
  }
}

// constructs {sname: {stateObj}}
function loadScripts(path) {
  let scripts = loadDirectoryScripts(path);
  for (let sname in scripts) {
    if (Scripts[sname]) continue;
    if (!scriptIsLocal(sname) && !scriptIsDepended(sname)) continue;
    Scripts[sname] = {stateObj: {}};
    try {
      Scripts[sname].stateObj = scripts[sname];
    } catch (e) {
      notifyError(e, 'loading script {}', sname);
    }
  }
  loadScriptDependencies();
}

// constructs a map {sname: [dname]}
function buildDependencyGraph() {
  let graph = {};
  for (let sname in Scripts) {
    let {depends} = Scripts[sname];
    graph[sname] = Object.keys(depends);
  }
  return graph;
}

// constructs a map {uri: filename}
function buildDownloadQueue() {
  let queue = {};
  for (let sname in Scripts) {
    let {depends} = Scripts[sname];
    for (let dname in depends) {
      let {uri} = depends[dname];
      if (!(dname in Scripts))
        queue[uri] = scriptNameToFilename(dname);
    }
  }
  return queue;
}

// downloads an uri to a file with a given filename inside a dir
function download(dir, uri, fname, cb, err) {
  fileLoad(Gio.file_new_for_uri(uri), (data) => {
    let file = dir.get_child(fname);
    fileWrite(file, data, cb, (e) => {
      err(errorWhen(e, 'writing to file {}', file.get_path()));
    });
  }, (e) => {
    err(errorWhen(e, 'retrieving {}', uri));
  });
}

// downloads all {uri: filename}, calls err on first failure
function downloadAll(dir, map, cb, err) {
  try {
    fileEnsureDir(dir);
  } catch (e) {
    err(errorWhen(e, 'ensuring {} is a writable directory', dir.get_path()));
    return;
  }
  let done = 0;
  for (let uri in map) {
    let fname = map[uri];
    download(dir, uri, fname, () => {
      if (++done !== Object.keys(map).length) return;
      cb();
    }, (...args) => {
      err.apply(null, args);
      err = function() {};
    });
  }
}

function loadLocal() {
  loadScripts(LocalDir.get_path());
}

// loads remote scripts until no more pending dependencies
function loadRemote(cb, first) {
  loadScripts(RemoteDir.get_path());
  let queue = buildDownloadQueue();
  let uris = Object.keys(queue);
  if (!uris.length) {
    if (!first) notify('Finished retrieving dependencies.');
    cb();
    return;
  }
  notify(format('Retrieving dependencies:\n{}', uris.join('\n')));
  downloadAll(RemoteDir, queue, () => loadRemote(cb), notifyError);
}

// enables scripts in dependency order, passing depends to init()
function enableScripts() {
  for (let sname of tsort(buildDependencyGraph())) {
    let {stateObj, depends} = Scripts[sname];
    let depObjs = {};
    for (let scr in depends) {
      let {alias} = depends[scr];
      depObjs[alias] = Scripts[scr].stateObj;
    }
    try {
      if (isFunction(stateObj.init)) stateObj.init(depObjs);
    } catch (e) {
      notifyError(e, 'initializing script {}', sname);
    }
    try {
      if (isFunction(stateObj.enable)) stateObj.enable();
    } catch (e) {
      notifyError(e, 'enabling script {}', sname);
    }
  }
}

// disables scripts in reverse dependency order
function disableScripts() {
  for (let sname of tsort(buildDependencyGraph()).reverse()) {
    let {stateObj} = Scripts[sname];
    try {
      if (isFunction(stateObj.disable)) stateObj.disable();
    } catch (e) {
      notifyError(e, 'disabling script {}', sname);
    }
  }
}

function enable() {
  Scripts = {};
  loadLocal();
  loadRemote(enableScripts, true);
}

function disable() {
  disableScripts();
}
