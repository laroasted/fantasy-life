// Fantasy Life Hub — Storage abstraction
//
// Wraps localStorage for local deployments.
// Swap this out for Supabase/Firebase/API calls if you want
// shared multi-user storage.
//
// The artifact version used window.storage (Anthropic's persistent storage).
// This version uses localStorage which works in any browser.

const STORAGE_PREFIX = "fl-";

/**
 * Get a value from storage.
 * @param {string} key
 * @returns {Promise<{value: string} | null>}
 */
export async function storageGet(key) {
  try {
    const value = localStorage.getItem(STORAGE_PREFIX + key);
    if (value !== null) {
      return { value };
    }
    return null;
  } catch (e) {
    console.error("Storage get error:", e);
    return null;
  }
}

/**
 * Set a value in storage.
 * @param {string} key
 * @param {string} value
 * @returns {Promise<{key: string, value: string} | null>}
 */
export async function storageSet(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, value);
    return { key, value };
  } catch (e) {
    console.error("Storage set error:", e);
    return null;
  }
}

/**
 * Delete a value from storage.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function storageDelete(key) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + key);
    return true;
  } catch (e) {
    console.error("Storage delete error:", e);
    return false;
  }
}

// Storage keys used by the app
export const STORAGE_KEYS = {
  ACTIVE_SEASON: "active-season",
  ARCHIVED_SEASONS: "archived-seasons",
};