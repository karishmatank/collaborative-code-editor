import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';

const userPresenceEl = document.getElementById('user-presence');
const editorContainerEl = document.getElementById('monaco-container');
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
        const otherColors = this.users
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
    let usedColors = this.users.map(info => info.color);
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

  get output() {
    return this.ymap.get('output') ?? '';
  }

  set output(newOutput) {
    this.ymap.set('output', newOutput);
  }

  get language() {
    return this.ymap.get('language');
  }

  set language(newLanguage) {
    // Update state to reflect new language
    this.ymap.set('language', newLanguage);
  }

  get users() {
    // Each entry is an object with keys 'name' and 'color'
    return Array.from(
      this.provider.awareness.getStates().values()
    ).map(value => value.user).filter(Boolean);
  }

  onCursorMovement() {
    // We'll insert new CSS to display each user's color 
    // into the HTML through the <style> element

    if (!this._cursorStyleEl) {
      this._cursorStyleEl = document.createElement('style');
      document.head.appendChild(this._cursorStyleEl);
    }

    this.provider.awareness.on('update', () => {
      const rules = [];
      this.provider.awareness.getStates().forEach((state, clientId) => {
        const color = state.user?.color;
        if (!color) return;

        // 4D ≈ 30% opacity for the selection background
        rules.push(`
          .yRemoteSelection-${clientId} {
            background-color: ${color}4D;
          }
          .yRemoteSelectionHead-${clientId} {
            border-left-color: ${color};
          }
          .yRemoteSelectionHead-${clientId}::after {
            background-color: ${color};
          }
        `);
      });
      this._cursorStyleEl.textContent = rules.join('\n');
    });
  }

  setupCursorTooltip() {
    // Append tooltip as a <div> and at body level
    // We've seen that overflow:hidden ancestors can clip the tooltip otherwise
    // Especially if the remote cursor is on the first line of the editor
    const tooltip = document.createElement('div');
    tooltip.style.cssText = `
      position: fixed;
      display: none;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-family: sans-serif;
      line-height: 1.6;
      color: #fff;
      pointer-events: none;
      z-index: 1000;
      white-space: nowrap;
    `;
    document.body.appendChild(tooltip);

    const TOOLTIP_HEIGHT = 22;

    editorContainerEl.addEventListener('mousemove', (e) => {
      // Check if hovering over a per-user cursor head element
      const head = e.target.closest?.('[class*="yRemoteSelectionHead-"]');
      if (!head) {
        tooltip.style.display = 'none';
        return;
      }

      const match = head.className.match(/yRemoteSelectionHead-(\d+)/);
      if (!match) return;

      const clientId = parseInt(match[1]);
      const state = this.provider.awareness.getStates().get(clientId);
      if (!state?.user) return;

      const { name, color } = state.user;
      tooltip.textContent = name;
      tooltip.style.backgroundColor = color;
      tooltip.style.display = 'block';

      // Tooltip displayed above the cursor
      const rect = head.getBoundingClientRect();
      const dotHeight = parseFloat(window.getComputedStyle(head, '::after').height) || 6;
      tooltip.style.left = `${rect.left}px`;
      tooltip.style.top = `${rect.top - TOOLTIP_HEIGHT + dotHeight}px`;

    });

    editorContainerEl.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
  }
} 

function renderPills() {
  userPresenceEl.innerHTML = '';
  controller.users.forEach(({ name, color }) => {
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

  controller.onCursorMovement();
  controller.setupCursorTooltip();

  return controller;
}