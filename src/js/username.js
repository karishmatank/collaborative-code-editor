export const MAX_USER_NAME_LEN = 40;

// Helper functions
export function isEmptyUserName(username) {
  if (username === '') {
    return true;
  }
  return false;
}

export function isLengthyUserName(username) {
  if (username.length > MAX_USER_NAME_LEN) {
    return true;
  }
  return false;
}