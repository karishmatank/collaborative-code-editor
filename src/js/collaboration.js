import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';

const userPresenceEl = document.getElementById('user-presence');
let controller;

class ConnectionManager {
  static ALL_COLORS = [
    '#FF6B6B', // coral red
    '#FF9F43', // tangerine
    '#FECA57', // sunglow yellow
    '#C4E538', // yellow-green
    '#1DD1A1', // mint
    '#10AC84', // teal green
    '#48DBFB', // sky cyan
    '#54A0FF', // periwinkle blue
    '#5F27CD', // deep purple
    '#D980FA', // orchid
    '#9980FA', // lavender
    '#FF9FF3', // pastel pink
    '#FD79A8', // hot pink
    '#EE5A24', // orange-red
    '#F8C291', // peach
    '#6AB04C', // lime green
    '#27AE60', // emerald
    '#12CBC4', // cyan teal
    '#82589F', // grape purple
    '#833471', // plum
  ];

  constructor(roomId, editor) {
    this.roomId = roomId;
    this.editor = editor;

    // Shared doc with shared types
    // We will create a new Y.Text per language instead
    this.ydoc = new Y.Doc();
    this.ymap = this.ydoc.getMap();

    // WebSocket connection
    this.provider = new WebsocketProvider(import.meta.env.VITE_WS_URL, `room-${roomId}`, this.ydoc);

    // User info with initial color - random pick, no peer check yet
    // Awareness info may not have come in yet for remote users
    this.username = localStorage.getItem('username');
    this.color = this.getNewUserColor();
    this.setUserAwareness();

    // Listener to reassign color once remote user awareness info arrives
    const confirmColor = ({ added, updated, removed }) => {
      // Make sure that we don't trigger our logic if the changes we received
      // are our own
      const localId = this.provider.awareness.clientID;
      const hasRemoteChange = [...added, ...updated, ...removed].some(id => id !== localId);
      if (hasRemoteChange) {
        this.provider.awareness.off('change', confirmColor);

        // Only trigger logic if we need to change the color
        const otherColors = this.getAllUsersInfo()
          .filter(info => !(info.name === this.username && info.color === this.color))
          .map(info => info.color);
        if (otherColors.includes(this.color)) {
          this.color = this.getNewUserColor();
          this.setUserAwareness();
        }
      }
    };
    this.provider.awareness.on('change', confirmColor);


    // One "connection" per language
    this.bindings = {};
  }

  onFirstSync(callback) {
    // Sync event is fired when the client receives content from the server
    // We only want this to run once upon the first sync, hence the `off` call
    const handler = isSynced => {
      if (isSynced) {
        this.provider.off('sync', handler);
        callback();
      }
    }
    this.provider.on('sync', handler);
  }

  switchLanguage(language, initialCode) {
    // Initialize collaboration per model with new language
    // or select the binding if it already exists

    let binding = this.bindings[language];
    if (!binding) {
      this.ytext = this.ydoc.getText(`monaco-${language}`);
      if (this.ytext.length === 0 && initialCode) {
        this.ytext.insert(0, initialCode);
      }

      // Bind to editor
      binding = new MonacoBinding(
        this.ytext, 
        this.editor.getModel(), 
        new Set([this.editor]),
        this.provider.awareness
      );

      // Store for future use
      this.bindings[language] = binding;
    }
    
    this.binding = binding;
  }

  getNewUserColor() {
    // Get array of all available colors
    let usedColors = this.getAllUsersInfo().map(info => info.color);
    let availableColors = ConnectionManager.ALL_COLORS.filter(color => !usedColors.includes(color));
    
    // Choose random color
    let idx = Math.floor(Math.random() * availableColors.length);
    return availableColors[idx];
  }

  setUserAwareness() {
    this.provider.awareness.setLocalStateField('user', {
      name: this.username,
      color: this.color
    });
  }

  getLatestOutput() {
    return this.ymap.get('output') ?? '';
  }

  setLatestOutput(newOutput) {
    this.ymap.set('output', newOutput);
  }

  getCurrentLanguage() {
    return this.ymap.get('language');
  }

  setNewLanguage(newLanguage) {
    // Update state to reflect new language
    this.ymap.set('language', newLanguage);
  }

  getAllUsersInfo() {
    // Each entry is an object with keys 'name' and 'color'
    return Array.from(
      this.provider.awareness.getStates().values()
    ).map(value => value.user).filter(Boolean);
  }
} 

function renderPills() {
  userPresenceEl.innerHTML = '';
  controller.getAllUsersInfo().forEach(({ name, color }) => {
    const pill = document.createElement('span');
    pill.className = 'user-pill';

    const dot = document.createElement('span');
    dot.className = 'user-pill-dot';
    dot.style.background = color;

    const label = document.createElement('span');
    label.textContent = name === controller.username ? `${name} (you)` : name;

    pill.appendChild(dot);
    pill.appendChild(label);
    userPresenceEl.appendChild(pill);
  });
}

export function initializeCollaboration(
  roomId, 
  editor, 
  language = 'python', 
  initialCode = null
) {
  controller = new ConnectionManager(roomId, editor);
  controller.switchLanguage(language, initialCode);
  
  // Display users in the UI
  controller.provider.awareness.on('change', renderPills);
  renderPills();

  return controller;
}