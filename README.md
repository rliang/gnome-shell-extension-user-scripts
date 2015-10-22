# gnome-shell-extension-user-scripts
Load scripts from `~/.local/share/gnome-shell/userscripts`.

## Features
* Dependency resolution
* Remote loading

## Installation
1. Clone this repo to `~/.local/share/gnome-shell/extensions`.
2. Enable this extension through `gnome-shell-extension-tool` or Gnome Tweak
   Tool.
3. To reload scripts, disable and re-enable the extension.

## Script Specification
Just like in extensions, initialization can be done through pre-defined
functions:

```javascript
const Main = imports.ui.main;

let dep1, dep2, dep3;

function depends() {
  return {
    'dep1': 'file1', // file1.js in the same directory
    'dep2': 'file:///usr/share/.../file2.js',
    'dep3': 'https://raw.githubusercontent.com/.../file3.js'
  };
}

function init(depends) {
  {dep1, dep2, dep3} = depends;
}

function enable() {
  Main.notify('hello world');
}

function disable() {
  Main.notify('goodbye world');
}
```

## License
GPL3
