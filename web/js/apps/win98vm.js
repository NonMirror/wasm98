/* Windows 98 VM -- boots a built-in or user-selected disk image in DOSBox-X.
 *
 * Built-in images are shipped under web/games/ and loaded from the same local
 * wasm98 filesystem.  User images stay in the browser's memory for the life
 * of the VM.  The host file bridge is used only after the user presses the
 * picker button, pastes, or explicitly drops an image; no host paths are scanned and no image is uploaded.
 */
(function () {
  'use strict';

  if (typeof W98 === 'undefined' || !W98 || typeof W98.registerApp !== 'function') return;

  var ACCEPT = '.img,.ima,.iso,.vhd,.vhdx,.hdd,.raw,application/octet-stream';
  var IMAGE_EXT = /\.([a-z0-9]+)$/i;
  var BUILTIN_IMAGES = [
    {
      id: 'simple',
      title: 'WASM98 Simple Boot',
      file: 'games/w98-simple.iso',
      description: 'Small boot-path diagnostic image.'
    },
    {
      id: 'ctf',
      title: 'WASM98 CTF #1',
      file: 'games/w98-ctf.iso',
      description: 'Easy XOR reverse-engineering challenge.'
    }
  ];

  function siteRoot() {
    var s = document.currentScript;
    var m = s && s.src && /^(.*\/)js\/apps\/[^\/]*$/.exec(s.src);
    if (m) return m[1];
    return location.pathname.replace(/[^\/]*$/, '');
  }

  var ROOT = siteRoot();

  function bridge() {
    return W98.hostFiles || window.W98HostFileBridge || window.hostFileBridge || null;
  }

  function ext(name) {
    var m = IMAGE_EXT.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function imageType(name) {
    return ext(name) === 'iso' ? 'iso' : 'hdd';
  }

  function isImageName(name) {
    return /\.(?:img|ima|iso|vhd|vhdx|hdd|raw)$/i.test(String(name || ''));
  }

  function imageLabel(name) {
    var clean = String(name || 'Windows 98 image').replace(/[\\/]+/g, '/').split('/').pop();
    return clean || 'Windows 98 image';
  }

  function configFor(type) {
    var image = type === 'iso' ? 'WIN98.ISO' : 'WIN98.IMG';
    var boot;
    if (type === 'iso') {
      /* DOSBox-X exposes an El Torito CD boot image through a temporary
         floppy drive, then boots that A: drive. */
      boot = 'imgmount d ' + image + ' -t iso\nimgmount a -bootcd d\nboot a:';
    } else {
      /* DOSBox-X's image boot path handles both a partitioned hard-disk image
         and a floppy-style image.  -fs none keeps DOSBox from mounting the
         filesystem itself and lets the guest Windows 98 driver see it. */
      boot = 'imgmount 2 ' + image + ' -t hdd -fs none\nboot -l c ' + image;
    }
    return [
      '[sdl]',
      'autolock=false',
      'fullscreen=false',
      'fulldouble=false',
      'fullresolution=original',
      'windowresolution=original',
      'output=surface',
      'sensitivity=100',
      'waitonerror=true',
      'priority=higher,normal',
      'mapperfile=mapper-jsdos.map',
      'usescancodes=true',
      'vsync=false',
      '',
      '[dosbox]',
      'machine=svga_s3',
      'memsize=64',
      'language=',
      'captures=capture',
      '',
      '[cpu]',
      'core=dynamic',
      'cputype=pentium',
      'cycles=auto',
      'cycleup=10',
      'cycledown=20',
      '',
      '[mixer]',
      'nosound=false',
      'rate=44100',
      'blocksize=1024',
      'prebuffer=20',
      '',
      '[render]',
      'frameskip=0',
      'aspect=false',
      'scaler=none',
      '',
      '[midi]',
      'mpu401=intelligent',
      'mididevice=none',
      '',
      '[sblaster]',
      'sbtype=sb16',
      'sbbase=220',
      'irq=7',
      'dma=1',
      'hdma=5',
      '',
      '[autoexec]',
      'mount c .',
      'c:',
      boot,
      ''
    ].join('\n');
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function loadBuiltin(entry) {
    return fetch(ROOT + entry.file, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('Built-in image returned HTTP ' + res.status + '.');
      return res.arrayBuffer();
    }).then(function (data) {
      var bytes = new Uint8Array(data);
      if (!bytes.length) throw new Error('The built-in image is empty.');
      return bytes;
    });
  }

  function create(win) {
    if (win.setIcon) win.setIcon('my-computer');
    win.setTitle('Windows 98 Virtual Machine');

    var root = document.createElement('div');
    root.style.cssText = 'height:100%;box-sizing:border-box;padding:12px;font:11px Tahoma,"MS Sans Serif",sans-serif;display:flex;flex-direction:column;gap:10px;';
    var heading = document.createElement('div');
    heading.style.cssText = 'font-size:14px;font-weight:bold;';
    heading.textContent = 'Run a Windows 98 disk image';
    var text = document.createElement('div');
    text.style.cssText = 'line-height:1.45;';
    text.innerHTML = 'Choose a bootable Windows 98 hard-disk or CD image. The image is passed directly to the local DOSBox-X WebAssembly runtime and stays on this device.';
    var info = document.createElement('div');
    info.className = 'w98-raised';
    info.style.cssText = 'padding:8px;line-height:1.45;';
    info.innerHTML = '<b>Supported images</b><br>.img, .ima, .vhd, .vhdx, .hdd, .raw, or .iso<br><br>' +
      '<b>Before starting</b><br>The image must already be bootable and contain a working Windows 98 installation. Installation media can boot to setup, but it will need a writable hard-disk image.';
    var builtins = document.createElement('div');
    builtins.className = 'w98-raised';
    builtins.style.cssText = 'padding:8px;line-height:1.35;';
    var builtinsTitle = document.createElement('div');
    builtinsTitle.style.cssText = 'font-weight:bold;margin-bottom:5px;';
    builtinsTitle.textContent = 'Built-in images';
    builtins.appendChild(builtinsTitle);
    var builtinsNote = document.createElement('div');
    builtinsNote.style.cssText = 'margin-bottom:6px;';
    builtinsNote.textContent = 'These images are included in wasm98 and do not require a file picker.';
    builtins.appendChild(builtinsNote);
    var builtinButtons = [];
    BUILTIN_IMAGES.forEach(function (entry) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:7px;margin-top:4px;';
      var button = document.createElement('button');
      button.textContent = 'Run ' + entry.title;
      button.title = entry.description;
      row.appendChild(button);
      var label = document.createElement('span');
      label.textContent = entry.description;
      row.appendChild(label);
      builtins.appendChild(row);
      builtinButtons.push(button);
    });
    var status = document.createElement('div');
    status.style.cssText = 'min-height:30px;line-height:1.4;';
    status.textContent = 'No image selected.';
    var drop = document.createElement('div');
    drop.className = 'w98-vm-drop';
    drop.style.cssText = 'border:1px dashed #555;background:#dfdfdf;text-align:center;padding:8px;color:#404040;';
    drop.textContent = 'Drop or paste a bootable image here';
    var buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;margin-top:auto;';
    var open = document.createElement('button');
    open.className = 'default';
    open.textContent = '&Open image…';
    var paste = document.createElement('button');
    paste.textContent = 'Paste image…';
    paste.title = 'Paste a disk image from the clipboard';
    paste.setAttribute('aria-label', 'Paste disk image from clipboard');
    var close = document.createElement('button');
    close.textContent = 'Close';
    buttons.appendChild(open);
    buttons.appendChild(paste);
    buttons.appendChild(close);
    root.appendChild(heading);
    root.appendChild(text);
    root.appendChild(builtins);
    root.appendChild(info);
    root.appendChild(status);
    root.appendChild(drop);
    root.appendChild(buttons);
    win.el.appendChild(root);
    win.setStatus([{ text: 'DOSBox-X WebAssembly', width: 180 }, { text: 'Built-in + local image' }]);

    close.addEventListener('click', function () { win.close(); });

    function setBusy(value) {
      open.disabled = value;
      paste.disabled = value;
      builtinButtons.forEach(function (button) { button.disabled = value; });
      drop.style.opacity = value ? '0.65' : '1';
    }

    function showError(err) {
      if (win.closed) return;
      status.textContent = 'Unable to open image: ' + (err.message || err);
      if (W98.dialog) W98.dialog.alert('Windows 98 VM', 'Unable to open the selected image:\n\n' + (err.message || err), 'error');
    }

    function launchImage(name, bytes, id) {
      if (!bytes || !bytes.length) throw new Error('The selected image is empty.');
      if (win.closed) return;
      var type = imageType(name);
      var guestName = type === 'iso' ? 'WIN98.ISO' : 'WIN98.IMG';
      var init = [
        { dosboxConf: configFor(type), jsdosConf: { version: '8.5.0' } },
        { path: guestName, contents: bytes }
      ];
      status.textContent = 'Starting DOSBox-X with ' + name + ' (' + fmtBytes(bytes.length) + ')…';
      W98.launch('dosgame', {
        id: 'win98-' + id,
        title: 'Windows 98',
        icon: 'my-computer',
        kind: 'win98',
        dosboxX: true,
        init: init
      });
      win.close();
    }

    function readHostImage(file) {
      var b = bridge();
      if (!b || typeof b.readImage !== 'function') {
        throw new Error('Host file access is unavailable in this browser.');
      }
      if (!file || !isImageName(file.name)) {
        throw new Error('Drop a .img, .ima, .vhd, .vhdx, .hdd, .raw, or .iso image.');
      }
      var name = imageLabel(file.name);
      status.textContent = 'Reading ' + name + ' (' + fmtBytes(file.size) + ')…';
      return b.readImage(file).then(function (bytes) {
        launchImage(name, bytes, 'user');
      });
    }

    function readClipboardImage(event) {
      var b = bridge();
      if (!b || typeof b.readClipboardFiles !== 'function') {
        throw new Error('Clipboard file access is unavailable in this browser.');
      }
      return Promise.resolve(b.readClipboardFiles(event)).then(function (files) {
        files = files || [];
        var file = null;
        for (var i = 0; i < files.length; i += 1) {
          if (files[i] && isImageName(files[i].name)) { file = files[i]; break; }
        }
        if (!file) throw new Error('The clipboard does not contain a supported disk image.');
        return readHostImage(file);
      });
    }

    function pasteImage() {
      if (paste.disabled) return;
      setBusy(true);
      status.textContent = 'Reading a disk image from the clipboard…';
      Promise.resolve().then(function () { return readClipboardImage(); }).catch(showError).then(function () {
        if (!win.closed) setBusy(false);
      });
    }

    function pasteEvent(event) {
      var b = bridge();
      /* Ignore ordinary text paste.  A file item is handled below, including
         browser Clipboard API fallbacks exposed by the host-file bridge. */
      if (b && typeof b.isFilePaste === 'function' && !b.isFilePaste(event)) return;
      if (!b || typeof b.readClipboardFiles !== 'function') return;
      if (!b.isFilePaste) {
        var data = event && event.clipboardData, hasFile = !!(data && data.files && data.files.length);
        if (!hasFile && data && data.items) {
          hasFile = Array.prototype.some.call(data.items, function (item) { return item && item.kind === 'file'; });
        }
        if (!hasFile) return;
      }
      event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      if (paste.disabled) return;
      setBusy(true);
      status.textContent = 'Reading a disk image from the clipboard…';
      Promise.resolve().then(function () { return readClipboardImage(event); }).catch(showError).then(function () {
        if (!win.closed) setBusy(false);
      });
    }

    BUILTIN_IMAGES.forEach(function (entry, index) {
      var button = builtinButtons[index];
      button.addEventListener('click', function () {
        if (button.disabled) return;
        setBusy(true);
        status.textContent = 'Loading built-in ' + entry.title + '…';
        loadBuiltin(entry).then(function (bytes) {
          launchImage(entry.file, bytes, entry.id);
        }).catch(showError).then(function () {
          if (!win.closed) setBusy(false);
        });
      });
    });

    open.addEventListener('click', function () {
      var b = bridge();
      if (!b || typeof b.pickFiles !== 'function' || typeof b.readImage !== 'function') {
        status.textContent = 'Host file access is unavailable in this browser.';
        return;
      }
      setBusy(true);
      status.textContent = 'Choose an image…';
      b.pickFiles({ multiple: false, accept: ACCEPT }).then(function (files) {
        if (!files || !files.length) {
          status.textContent = 'No image selected.';
          return null;
        }
        var file = files[0];
        return readHostImage(file);
      }).catch(function (err) {
        showError(err);
      }).then(function () {
        if (!win.closed) setBusy(false);
      });
    });
    paste.addEventListener('click', pasteImage);
    win.el.addEventListener('paste', pasteEvent);

    function dragLeave() {
      drop.classList.remove('w98-vm-drop-active');
      drop.style.background = '#dfdfdf';
      drop.style.color = '#404040';
    }
    function dragOver(event) {
      var files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      drop.classList.add('w98-vm-drop-active');
      drop.style.background = '#ffffc0';
      drop.style.color = '#000080';
    }
    function dropImage(event) {
      var files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) return;
      event.preventDefault();
      event.stopPropagation();
      dragLeave();
      if (open.disabled) return;
      setBusy(true);
      Promise.resolve().then(function () { return readHostImage(files[0]); }).catch(showError).then(function () {
        if (!win.closed) setBusy(false);
      });
    }
    drop.addEventListener('dragover', dragOver);
    drop.addEventListener('dragleave', dragLeave);
    drop.addEventListener('drop', dropImage);

    return { onClose: function () {
      dragLeave();
      drop.removeEventListener('dragover', dragOver);
      drop.removeEventListener('dragleave', dragLeave);
      drop.removeEventListener('drop', dropImage);
      paste.removeEventListener('click', pasteImage);
      win.el.removeEventListener('paste', pasteEvent);
    } };
  }

  W98.registerApp({
    id: 'win98vm',
    title: 'Windows 98 Virtual Machine',
    icon: 'my-computer',
    width: 500,
    height: 430,
    minWidth: 420,
    minHeight: 360,
    resizable: true,
    maximizable: true,
    singleton: true,
    desktop: false,
    startMenuGroup: 'System Tools',
    create: create
  });
})();
