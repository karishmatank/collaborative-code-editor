import { initializeModal } from './modal.js';
import { initializeResizers } from './resizer.js';
import { initializeEditor } from './editor.js';
import { initializeOutput, renderIFrame, setOutputContent } from './output.js';
import { initializeCollaboration } from './collaboration.js';
import { getPadLanguage, setPadLanguage, getPadContents, setPadContents } from './persistence.js';

const languageDropdown = document.getElementById('language-select');
const runBtn = document.getElementById('run-btn');
const resetBtn = document.getElementById('reset-btn');
const htmlDivider = document.getElementById('divider-html');
const iframePane = document.getElementById('iframe-pane');

const padId = window.location.pathname.split('/').pop();

let editorController;
let collabController;

function isReturningUser() {
  return localStorage.getItem('username') !== null;
}

function applyLanguageChange(newLanguage) {
  languageDropdown.value = newLanguage;
  editorController.switchLanguage(newLanguage);
  collabController.switchLanguage(newLanguage);

  if (newLanguage === 'html') {
    runBtn.disabled = true;
    htmlDivider.hidden = false;
    iframePane.hidden = false;
    resetBtn.hidden = true;
  } else {
    runBtn.disabled = false;
    htmlDivider.hidden = true;
    iframePane.hidden = true;
    resetBtn.hidden = false;
  }
}

async function onFirstSyncLogic(language) {
  const isFirstUser = collabController.users.length <= 1;

  // If the user is the only user in the room, set the editor content and language from the database
  if (isFirstUser) {
    collabController.language = language;
    applyLanguageChange(language);

    let content = await getPadContents(padId, language);
    collabController.setEditorContent(content);
  } else {
    // Set the latest output from the room
    setOutputContent(collabController.output);

    // Switch to the room language
    const syncedLanguage = collabController.language;
    if (syncedLanguage && syncedLanguage !== languageDropdown.value) {
      applyLanguageChange(syncedLanguage);
    }
  }
}

function lastUserUnload() {
  const isLastUser = collabController.users.length === 1;

  // If the user is the last in the room, update the database with the editor contents
  if (isLastUser) {
    const language = languageDropdown.value;
    const editorContents = collabController.ytext.toJSON();
    setPadContents(padId, language, editorContents);
  }
}

async function langDropdownChange(event) {
  // Set current editor contents for the "old" language
  const oldLanguage = await getPadLanguage(padId);  
  const editorContents = collabController.ytext.toJSON();
  setPadContents(padId, oldLanguage, editorContents);

  const newLanguage = event.target.value;

  // Capture first visit before applying language change
  const isFirstVisit = !collabController.bindings[newLanguage];

  // Set new "last seen" language in the database
  setPadLanguage(padId, newLanguage);

  // If the language selected is HTML, disable the run button and unhide the iframe
  // Also with HTML, then change our populated output to be viewed all the time
  applyLanguageChange(newLanguage);
  collabController.language = newLanguage;
  collabController.output = '';

  // If users haven't used the new language before in a given session
  // Get the last seen contents for the language from the database
  if (isFirstVisit) {
    let content = await getPadContents(padId, newLanguage);
    collabController.setEditorContent(content);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  initializeResizers();
  initializeOutput();

  // If user already provided their name, render editor straight away
  // as the app is already visible.
  // Otherwise, render modal, then editor as app only visible after
  if (!isReturningUser()) {
    // If Monaco initializes while its container is hidden (display: none), 
    // it can't measure the container dimensions
    await initializeModal();
  }

  // Get last language of pad from the database
  // Ideally we don't need each user to do the lookup, only the first should
  // However, that causes an infinite loop- to know whether a user is the first,
  // we need to wait for WebSocket to sync, which happens within initializeCollaborator
  // where we need a language to input in for the initialization
  // We solve this by just having every user look up the pad language
  let initialLanguage;
  try {
    initialLanguage = await getPadLanguage(padId);
  } catch (error) {
    window.location.replace('/invalid.html');
    return;
  }

  editorController = initializeEditor(padId, initialLanguage);

  collabController = initializeCollaboration(
    padId, 
    editorController.editor, 
    initialLanguage
  );

  applyLanguageChange(initialLanguage);

  // Set the dropdown to sync with initial language
  languageDropdown.value = initialLanguage;

  // Code to execute on first sync
  // For a joining user, the WebSocket connection sync is async, and it
  // takes a moment. Meanwhile, we don't want to run any initialization
  // code that relies on Y.Map before WebSocket is completely set up
  collabController.onFirstSync(async () => {
    await onFirstSyncLogic(initialLanguage);
  });

  // Code to execute before a user leaves the page
  window.addEventListener('beforeunload', lastUserUnload);

  // Language dropdown listener to change editor
  languageDropdown.addEventListener('change', async event => {
    await langDropdownChange(event);
  });

  // Render iframe with HTML mode upon changes in the editor
  editorController.onContentChange(event => {
    if (languageDropdown.value === 'html') {
      renderIFrame(event);
    }
  }, 300);

  // Save changes to ytext to the database
  // We add this on ydoc and not ytext because we switch to a new ytext
  // with each language change
  let saveTimer;
  collabController.ydoc.on('update', (update, origin, doc, transaction) => {
    // Ignore remote changes
    if (!transaction.local) return;

    // Ignore mutations other than on the current ytext
    if (!transaction.changed.has(collabController.ytext)) return;

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      setPadContents(padId, languageDropdown.value, collabController.ytext.toJSON());
    }, 3000);
  });

  // Look out for changes in Y.Map for language and output
  collabController.ymap.observe(event => {
    if (event.keysChanged.has('output')) {
      setOutputContent(collabController.output);
    }
    if (event.keysChanged.has('language') && !event.transaction.local) {
      let language = collabController.language;
      applyLanguageChange(language);
    }
  });

  // Run button clicked
  runBtn.addEventListener('click', () => {
    // TODO: Run the code and get the real result back
    const preMessage = `${collabController.username} has run the code!\n\n`;
    const result = '...placeholder...';
    collabController.output = preMessage + result + '\n\n';
  });

  // Reset button clicked
  resetBtn.addEventListener('click', () => {
    collabController.output = '';
  });

});