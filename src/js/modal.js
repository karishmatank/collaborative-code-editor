const MAX_USER_NAME_LEN = 40;

// Helper functions
function isEmptyUserName(username) {
  if (username === '') {
    return true;
  }
  return false;
}

function isLengthyUserName(username) {
  if (username.length > MAX_USER_NAME_LEN) {
    return true;
  }
  return false;
}

function hideNameModal() {
  // Setting hidden=true is safe — we only ever hide the modal via JS,
  // never need to override it back to visible with CSS.
  document.getElementById('name-modal').hidden = true;
}

function showApp() {
  // Use a CSS class rather than the hidden attribute. The hidden attribute
  // carries display:none !important in all modern browsers, which can't be
  // overridden by author styles (as the .returning-user rule needs to do).
  document.documentElement.classList.add('returning-user');
}


// Process a username from the modal
function processUserName(event) {
  let submittedName = document.getElementById('name-input').value;
  let cleanedName = submittedName.trim();
  let errorP = document.getElementById('name-error');

  if (isEmptyUserName(cleanedName)) {
    errorP.textContent = 'Provided name is invalid. Please try again.';
  } else if (isLengthyUserName(cleanedName)) {
    errorP.textContent = 'Provided name is too long. Please enter a shorter name.';
  } else {
    // Hide modal and show the app
    hideNameModal();
    showApp();

    // Use localStorage to store cookie in the browser
    localStorage.setItem('username', cleanedName);

    // TODO: pass username to Yjs awareness once collaboration is set up

  }
}

export function initializeModal(onComplete) {
  let nameModalSubmit = document.getElementById('name-submit');
  nameModalSubmit.addEventListener('click', event => {
    processUserName(event);
    if (onComplete) {
      onComplete();
    }
  });
}