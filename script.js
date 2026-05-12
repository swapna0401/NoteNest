import {
  auth,
  db,
  storage,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  collection,
  addDoc,
  doc,
  deleteDoc,
  serverTimestamp,
  onSnapshot,
  query,
  orderBy,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "./firebase.js";

const openLoginBtn = document.getElementById("openLoginBtn");
const openSignupBtn = document.getElementById("openSignupBtn");
const logoutBtn = document.getElementById("logoutBtn");
const openUploadBtn = document.getElementById("openUploadBtn");
const loginModal = document.getElementById("loginModal");
const signupModal = document.getElementById("signupModal");
const uploadModal = document.getElementById("uploadModal");
const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");
const uploadForm = document.getElementById("uploadForm");
const resourcesGrid = document.getElementById("resourcesGrid");
const emptyState = document.getElementById("emptyState");
const toast = document.getElementById("toast");
const searchInput = document.getElementById("searchInput");
const semesterFilter = document.getElementById("semesterFilter");
const typeFilter = document.getElementById("typeFilter");
const submitUploadBtn = document.getElementById("submitUploadBtn");
const profileChip = document.getElementById("profileChip");
const profileAvatar = document.getElementById("profileAvatar");
const profileEmail = document.getElementById("profileEmail");
const bookmarkToggleBtn = document.getElementById("bookmarkToggleBtn");

let currentUser = null;
let allResources = [];
let authInitialized = false;
let localMode = false;
let resourcesUnsubscribe = null;

const LOCAL_KEYS = {
  user: "notenest_local_user",
  resources: "notenest_local_resources",
  bookmarks: "notenest_local_bookmarks",
  deletedRemoteIds: "notenest_deleted_remote_doc_ids",
};
const LOCAL_MODE_MAX_FILE_SIZE_MB = 25;
const LOCAL_DB_NAME = "notenest_local_db";
const LOCAL_DB_VERSION = 2;
const LOCAL_FILE_STORE = "files";
const LOCAL_META_STORE = "meta";
const LOCAL_RESOURCES_META_KEY = "resources";

let showOnlyBookmarks = false;
let showOnlyMyUploads = false;
let idbResourcesCache = [];
let lastRemoteResources = [];

function getFriendlyError(error, fallback = "Something went wrong") {
  const code = error?.code || "";
  const map = {
    "auth/invalid-credential": "Invalid email or password.",
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/email-already-in-use": "Email is already registered.",
    "auth/invalid-email": "Invalid email format.",
    "auth/operation-not-allowed": "Enable Email/Password in Firebase Auth.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "permission-denied": "Permission denied by Firebase rules.",
    "unauthenticated": "Please login first.",
    "storage/unauthorized": "Storage permission denied by Firebase rules.",
    "storage/object-not-found": "File not found in Storage.",
  };
  return map[code] || error?.message || fallback;
}

function readLocalResourcesFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEYS.resources) || "[]");
  } catch {
    return [];
  }
}

function readLocalResources() {
  const storageResources = readLocalResourcesFromStorage();
  const byId = new Map();
  // IndexedDB first, then localStorage — storage wins on same id (avoids stale IDB after delete).
  [...idbResourcesCache, ...storageResources].forEach((resource) => {
    if (resource?.id) byId.set(resource.id, resource);
  });
  return Array.from(byId.values());
}

function readDeletedRemoteIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEYS.deletedRemoteIds) || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function writeDeletedRemoteIds(idSet) {
  const arr = Array.from(idSet).slice(-200);
  localStorage.setItem(LOCAL_KEYS.deletedRemoteIds, JSON.stringify(arr));
}

function addDeletedRemoteId(id) {
  if (!id) return;
  const set = readDeletedRemoteIds();
  set.add(id);
  writeDeletedRemoteIds(set);
}

function pruneDeletedRemoteIds(snapshotDocIds) {
  const set = readDeletedRemoteIds();
  let changed = false;
  set.forEach((docId) => {
    if (!snapshotDocIds.has(docId)) {
      set.delete(docId);
      changed = true;
    }
  });
  if (changed) writeDeletedRemoteIds(set);
  return set;
}

function isLocalOnlyResource(resource) {
  return (
    String(resource?.id || "").startsWith("local-") ||
    String(resource?.storagePath || "").startsWith("local://") ||
    Boolean(resource?.fileDataId)
  );
}

function writeLocalResources(resources) {
  idbResourcesCache = resources;
  localStorage.setItem(LOCAL_KEYS.resources, JSON.stringify(resources));
  saveLocalResourcesToDb(resources).catch((error) => console.error(error));
}

function readLocalUser() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEYS.user) || "null");
  } catch {
    return null;
  }
}

function writeLocalUser(user) {
  if (!user) {
    localStorage.removeItem(LOCAL_KEYS.user);
    return;
  }
  localStorage.setItem(LOCAL_KEYS.user, JSON.stringify(user));
}

function mergeFirebaseWithLocal(remoteResources = [], localResources = []) {
  const mergedMap = new Map();
  remoteResources.forEach((resource) => {
    if (resource?.id) mergedMap.set(resource.id, resource);
  });
  localResources.forEach((resource) => {
    if (!resource?.id) return;
    if (isLocalOnlyResource(resource)) {
      mergedMap.set(resource.id, resource);
    }
  });
  return Array.from(mergedMap.values()).sort((a, b) => {
    const aTime =
      typeof a?.createdAt === "number"
        ? a.createdAt
        : typeof a?.createdAt?.toMillis === "function"
          ? a.createdAt.toMillis()
          : 0;
    const bTime =
      typeof b?.createdAt === "number"
        ? b.createdAt
        : typeof b?.createdAt?.toMillis === "function"
          ? b.createdAt.toMillis()
          : 0;
    return bTime - aTime;
  });
}

function getBookmarkKey() {
  return currentUser?.uid || currentUser?.email || "guest";
}

function readBookmarks() {
  try {
    const all = JSON.parse(localStorage.getItem(LOCAL_KEYS.bookmarks) || "{}");
    return all[getBookmarkKey()] || [];
  } catch {
    return [];
  }
}

function writeBookmarks(ids) {
  const key = getBookmarkKey();
  try {
    const all = JSON.parse(localStorage.getItem(LOCAL_KEYS.bookmarks) || "{}");
    all[key] = ids;
    localStorage.setItem(LOCAL_KEYS.bookmarks, JSON.stringify(all));
  } catch {
    localStorage.setItem(LOCAL_KEYS.bookmarks, JSON.stringify({ [key]: ids }));
  }
}

function toggleBookmark(resourceId) {
  if (!currentUser) {
    showToast("Login to save bookmarks");
    openModal(loginModal);
    return;
  }

  const bookmarks = readBookmarks();
  const next = bookmarks.includes(resourceId)
    ? bookmarks.filter((id) => id !== resourceId)
    : [...bookmarks, resourceId];
  writeBookmarks(next);
  renderResources();
}

function openLocalDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_FILE_STORE)) {
        db.createObjectStore(LOCAL_FILE_STORE);
      }
      if (!db.objectStoreNames.contains(LOCAL_META_STORE)) {
        db.createObjectStore(LOCAL_META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveLocalResourcesToDb(resources) {
  const db = await openLocalDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_META_STORE, "readwrite");
    tx.objectStore(LOCAL_META_STORE).put(resources, LOCAL_RESOURCES_META_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadLocalResourcesFromDb() {
  const db = await openLocalDb();
  const resources = await new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_META_STORE, "readonly");
    const request = tx.objectStore(LOCAL_META_STORE).get(LOCAL_RESOURCES_META_KEY);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return Array.isArray(resources) ? resources : [];
}

async function bootstrapLocalResources() {
  try {
    const dbResources = await loadLocalResourcesFromDb();
    const storageList = readLocalResourcesFromStorage();
    const byId = new Map();
    [...dbResources, ...storageList].forEach((resource) => {
      if (resource?.id) byId.set(resource.id, resource);
    });
    idbResourcesCache = Array.from(byId.values());
    const combined = readLocalResources();
    if (combined.length && !readLocalResourcesFromStorage().length) {
      localStorage.setItem(LOCAL_KEYS.resources, JSON.stringify(combined));
    }
    if (localMode || !allResources.length) {
      allResources = combined;
      renderResources();
    } else if (lastRemoteResources.length >= 0) {
      allResources = mergeFirebaseWithLocal(lastRemoteResources, readLocalResources());
      renderResources();
    }
  } catch (error) {
    console.error(error);
  }
}

async function saveLocalFile(fileDataId, dataUrl) {
  const db = await openLocalDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_FILE_STORE, "readwrite");
    tx.objectStore(LOCAL_FILE_STORE).put(dataUrl, fileDataId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function getLocalFile(fileDataId) {
  const db = await openLocalDb();
  const dataUrl = await new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_FILE_STORE, "readonly");
    const request = tx.objectStore(LOCAL_FILE_STORE).get(fileDataId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return dataUrl;
}

async function deleteLocalFile(fileDataId) {
  if (!fileDataId) return;
  const db = await openLocalDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_FILE_STORE, "readwrite");
    tx.objectStore(LOCAL_FILE_STORE).delete(fileDataId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function removeResourceFromLocalStores(id, fileDataId) {
  const storageList = readLocalResourcesFromStorage();
  const byId = new Map();
  [...idbResourcesCache, ...storageList].forEach((resource) => {
    if (resource?.id) byId.set(resource.id, resource);
  });
  byId.delete(id);
  const next = Array.from(byId.values());
  idbResourcesCache = next;
  try {
    localStorage.setItem(LOCAL_KEYS.resources, JSON.stringify(next));
  } catch (error) {
    console.error(error);
  }
  await saveLocalResourcesToDb(next);
  if (fileDataId) await deleteLocalFile(fileDataId);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function showToast(message, duration = 2500) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.setTimeout(() => toast.classList.add("hidden"), duration);
}

function enterLocalMode(message = "") {
  localMode = true;
  if (typeof resourcesUnsubscribe === "function") {
    resourcesUnsubscribe();
    resourcesUnsubscribe = null;
  }
  allResources = readLocalResources();
  renderResources();
  if (message) showToast(message);
}

function openModal(modalEl) {
  modalEl.classList.remove("hidden");
}

function closeModal(modalEl) {
  modalEl.classList.add("hidden");
}

function closeAllModals() {
  [loginModal, signupModal, uploadModal].forEach((modal) => closeModal(modal));
}

function setAuthUI(user) {
  const isLoggedIn = Boolean(user);
  openLoginBtn.classList.toggle("hidden", isLoggedIn);
  openSignupBtn.classList.toggle("hidden", isLoggedIn);
  logoutBtn.classList.toggle("hidden", !isLoggedIn);
  openUploadBtn.disabled = !isLoggedIn;
  openUploadBtn.title = isLoggedIn ? "" : "Login to upload resources";

  profileChip.classList.toggle("hidden", !isLoggedIn);
  if (isLoggedIn) {
    const email = user.email || "user@notenest";
    profileEmail.textContent = email;
    profileAvatar.textContent = email.slice(0, 2).toUpperCase();
  } else {
    showOnlyMyUploads = false;
    showOnlyBookmarks = false;
    bookmarkToggleBtn.textContent = "Bookmarks";
    profileChip.classList.remove("active");
    profileEmail.textContent = "Guest";
    profileAvatar.textContent = "NN";
  }
}

function applyFilters(resources) {
  const text = searchInput.value.trim().toLowerCase();
  const semester = semesterFilter.value;
  const type = typeFilter.value;
  const bookmarkIds = readBookmarks();

  return resources.filter((resource) => {
    const title = (resource.title || "").toLowerCase();
    const subject = (resource.subject || "").toLowerCase();
    const resourceSemester = resource.semester || "";
    const resourceType = resource.type || "";
    const isMine =
      Boolean(currentUser) &&
      (resource.uploaderUid === currentUser.uid ||
        (resource.uploadedBy && currentUser.email && resource.uploadedBy === currentUser.email));

    const matchesText =
      title.includes(text) ||
      subject.includes(text);
    const matchesSemester = !semester || resourceSemester === semester;
    const matchesType = !type || resourceType === type;
    const matchesBookmark = !showOnlyBookmarks || bookmarkIds.includes(resource.id);
    const matchesMine = !showOnlyMyUploads || isMine;
    return matchesText && matchesSemester && matchesType && matchesBookmark && matchesMine;
  });
}

function renderResources() {
  const filtered = applyFilters(allResources);
  resourcesGrid.innerHTML = "";

  if (!filtered.length) {
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");

  filtered.forEach((resource) => {
    const card = document.createElement("article");
    card.className = "resource-card glass";
    const canDelete =
      Boolean(currentUser) &&
      (resource.uploaderUid === currentUser.uid ||
        (resource.uploadedBy && currentUser.email && resource.uploadedBy === currentUser.email) ||
        (!resource.uploaderUid && !resource.uploadedBy));
    const safeTitle = resource.title || "Untitled";
    const safeSubject = resource.subject || "N/A";
    const safeSemester = resource.semester || "N/A";
    const safeType = resource.type || "Other";
    const safeUploadedBy = resource.uploadedBy || "Unknown";
    const bookmarked = readBookmarks().includes(resource.id);

    card.innerHTML = `
      <h3 class="resource-title">${safeTitle}</h3>
      <p class="resource-meta"><strong>Subject:</strong> ${safeSubject}</p>
      <p class="resource-meta"><strong>Semester:</strong> ${safeSemester}</p>
      <span class="badge">${safeType}</span>
      <p class="resource-meta"><strong>Uploaded by:</strong> ${safeUploadedBy}</p>
      <div class="card-actions">
        <button class="btn btn-ghost bookmark-btn ${bookmarked ? "active" : ""}" data-bookmark-id="${resource.id}">
          ${bookmarked ? "Bookmarked" : "Bookmark"}
        </button>
        ${
          resource.fileUrl
            ? `<a class="btn btn-secondary" href="${resource.fileUrl}" target="_blank" rel="noopener noreferrer">View</a>`
            : `<button class="btn btn-secondary view-local-btn" data-file-id="${resource.fileDataId}">View</button>`
        }
        ${
          canDelete
            ? `<button class="btn btn-danger delete-btn" data-id="${resource.id}" data-path="${resource.storagePath}">Delete</button>`
            : `<button class="btn btn-ghost" disabled>Delete</button>`
        }
      </div>
    `;
    resourcesGrid.appendChild(card);
  });
}

async function handleDelete(id, storagePath) {
  if (!currentUser) {
    showToast("Please login first");
    openModal(loginModal);
    return;
  }

  const confirmed = window.confirm("Delete this resource permanently?");
  if (!confirmed) return;

  try {
    const deletingResource = allResources.find((resource) => resource.id === id);
    const fileDataId = deletingResource?.fileDataId;

    if (localMode) {
      await removeResourceFromLocalStores(id, fileDataId);
      writeBookmarks(readBookmarks().filter((bookmarkId) => bookmarkId !== id));
      allResources = readLocalResources();
      renderResources();
    } else {
      await deleteDoc(doc(db, "resources", id));
      addDeletedRemoteId(id);
      await removeResourceFromLocalStores(id, fileDataId);
      writeBookmarks(readBookmarks().filter((bookmarkId) => bookmarkId !== id));
      allResources = allResources.filter((resource) => resource.id !== id);
      renderResources();

      if (storagePath && storagePath !== "undefined" && !storagePath.startsWith("local://")) {
        try {
          await deleteObject(ref(storage, storagePath));
        } catch (storageError) {
          console.error(storageError);
        }
      }
    }
    showToast("Resource deleted");
  } catch (error) {
    console.error(error);
    showToast(getFriendlyError(error, "Failed to delete resource"));
  }
}

async function handleSignup(event) {
  event.preventDefault();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;
  try {
    if (localMode) {
      const localUser = {
        uid: `local-${Date.now()}`,
        email,
      };
      currentUser = localUser;
      writeLocalUser(localUser);
      setAuthUI(localUser);
      showToast("Signed up in local mode");
      signupForm.reset();
      closeModal(signupModal);
      renderResources();
      return;
    }

    await createUserWithEmailAndPassword(auth, email, password);
    showToast("Signup successful");
    signupForm.reset();
    closeModal(signupModal);
  } catch (error) {
    console.error(error);
    showToast(getFriendlyError(error, "Signup failed"));
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  try {
    if (localMode) {
      const localUser = {
        uid: "local-user",
        email,
      };
      currentUser = localUser;
      writeLocalUser(localUser);
      setAuthUI(localUser);
      showToast("Logged in (local mode)");
      loginForm.reset();
      closeModal(loginModal);
      renderResources();
      return;
    }

    await signInWithEmailAndPassword(auth, email, password);
    showToast("Logged in successfully");
    loginForm.reset();
    closeModal(loginModal);
  } catch (error) {
    console.error(error);
    showToast(getFriendlyError(error, "Login failed"));
  }
}

async function handleUpload(event) {
  event.preventDefault();

  if (!currentUser) {
    showToast("Please login before uploading");
    openModal(loginModal);
    return;
  }

  const title = document.getElementById("title").value.trim();
  const subject = document.getElementById("subject").value.trim();
  const semester = document.getElementById("semester").value;
  const type = document.getElementById("type").value;
  const fileInput = document.getElementById("fileInput");
  const file = fileInput.files[0];

  if (!file) {
    showToast("Please choose a file");
    return;
  }

  submitUploadBtn.disabled = true;
  submitUploadBtn.textContent = "Uploading...";

  try {
    if (localMode) {
      const maxBytes = LOCAL_MODE_MAX_FILE_SIZE_MB * 1024 * 1024;
      if (file.size > maxBytes) {
        showToast(
          `Local mode supports files up to ${LOCAL_MODE_MAX_FILE_SIZE_MB}MB. Use smaller file or fix Firebase mode.`
        );
        return;
      }

      const fileUrl = await fileToDataUrl(file);
      const fileDataId = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await saveLocalFile(fileDataId, fileUrl);
      const localResource = {
        id: `local-${Date.now()}`,
        title,
        subject,
        semester,
        type,
        uploadedBy: currentUser.email,
        uploaderUid: currentUser.uid,
        fileUrl: "",
        fileDataId,
        storagePath: "local://browser-object-url",
        createdAt: Date.now(),
      };
      const updated = [localResource, ...readLocalResources()];
      try {
        writeLocalResources(updated);
      } catch (storageError) {
        console.error(storageError);
        showToast(
          "Storage is full in local mode. Delete some local uploads/bookmarks or configure Firebase."
        );
        return;
      }
      allResources = updated;
      renderResources();
    } else {
      const safeName = `${Date.now()}-${file.name.replace(/\s+/g, "_")}`;
      const storagePath = `resources/${currentUser.uid}/${safeName}`;
      const fileRef = ref(storage, storagePath);
      await uploadBytes(fileRef, file);
      const fileUrl = await getDownloadURL(fileRef);

      await addDoc(collection(db, "resources"), {
        title,
        subject,
        semester,
        type,
        uploadedBy: currentUser.email,
        uploaderUid: currentUser.uid,
        fileUrl,
        storagePath,
        createdAt: serverTimestamp(),
      });
    }

    showToast("Resource uploaded");
    uploadForm.reset();
    closeModal(uploadModal);
  } catch (error) {
    console.error(error);
    if (!localMode) {
      const maxBytes = LOCAL_MODE_MAX_FILE_SIZE_MB * 1024 * 1024;
      if (file.size <= maxBytes) {
        try {
          enterLocalMode();
          const fileUrl = await fileToDataUrl(file);
          const fileDataId = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          await saveLocalFile(fileDataId, fileUrl);
          const localResource = {
            id: `local-${Date.now()}`,
            title,
            subject,
            semester,
            type,
            uploadedBy: currentUser.email,
            uploaderUid: currentUser.uid,
            fileUrl: "",
            fileDataId,
            storagePath: "local://browser-object-url",
            createdAt: Date.now(),
          };
          const updated = [localResource, ...readLocalResources()];
          writeLocalResources(updated);
          allResources = updated;
          renderResources();
          showToast("Firebase upload failed, saved in local mode");
          uploadForm.reset();
          closeModal(uploadModal);
          return;
        } catch (fallbackError) {
          console.error(fallbackError);
        }
      }
    }
    showToast(getFriendlyError(error, "Upload failed"));
  } finally {
    submitUploadBtn.disabled = false;
    submitUploadBtn.textContent = "Upload Now";
  }
}

function subscribeResources() {
  if (localMode) {
    allResources = readLocalResources();
    renderResources();
    return;
  }

  const q = query(collection(db, "resources"), orderBy("createdAt", "desc"));
  const applySnapshot = (snapshot) => {
    const snapshotDocIds = new Set(snapshot.docs.map((resourceDoc) => resourceDoc.id));
    pruneDeletedRemoteIds(snapshotDocIds);

    const tombstones = readDeletedRemoteIds();
    const remoteResources = snapshot.docs
      .map((resourceDoc) => ({
        id: resourceDoc.id,
        ...resourceDoc.data(),
      }))
      .filter((resource) => !tombstones.has(resource.id));

    lastRemoteResources = remoteResources;
    const localResources = readLocalResources();
    allResources = mergeFirebaseWithLocal(remoteResources, localResources);
    renderResources();
  };

  resourcesUnsubscribe = onSnapshot(q, applySnapshot, (error) => {
    console.error(error);
    enterLocalMode("Firebase unavailable: switched to local mode");
  });
}

openLoginBtn.addEventListener("click", () => openModal(loginModal));
openSignupBtn.addEventListener("click", () => openModal(signupModal));
openUploadBtn.addEventListener("click", () => {
  if (!currentUser) {
    showToast("Login required to upload");
    openModal(loginModal);
    return;
  }
  openModal(uploadModal);
});
logoutBtn.addEventListener("click", async () => {
  try {
    if (localMode) {
      currentUser = null;
      writeLocalUser(null);
      setAuthUI(null);
      renderResources();
      showToast("Logged out");
      return;
    }
    await signOut(auth);
    showToast("Logged out");
  } catch (error) {
    console.error(error);
    showToast("Logout failed");
  }
});

document.querySelectorAll(".close-modal").forEach((btn) => {
  btn.addEventListener("click", (event) => {
    const target = event.currentTarget.getAttribute("data-close");
    closeModal(document.getElementById(target));
  });
});

window.addEventListener("click", (event) => {
  if ([loginModal, signupModal, uploadModal].includes(event.target)) {
    closeAllModals();
  }
});

loginForm.addEventListener("submit", handleLogin);
signupForm.addEventListener("submit", handleSignup);
uploadForm.addEventListener("submit", handleUpload);

searchInput.addEventListener("input", renderResources);
semesterFilter.addEventListener("change", renderResources);
typeFilter.addEventListener("change", renderResources);

resourcesGrid.addEventListener("click", (event) => {
  const viewLocalBtn = event.target.closest(".view-local-btn");
  if (viewLocalBtn) {
    const fileDataId = viewLocalBtn.getAttribute("data-file-id");
    getLocalFile(fileDataId)
      .then((dataUrl) => {
        if (!dataUrl) {
          showToast("File not found in local storage");
          return;
        }
        window.open(dataUrl, "_blank", "noopener,noreferrer");
      })
      .catch((error) => {
        console.error(error);
        showToast("Could not open local file");
      });
    return;
  }

  const bookmarkTarget = event.target.closest(".bookmark-btn");
  if (bookmarkTarget) {
    const bookmarkId = bookmarkTarget.getAttribute("data-bookmark-id");
    toggleBookmark(bookmarkId);
    return;
  }

  const target = event.target.closest(".delete-btn");
  if (!target) return;
  const id = target.getAttribute("data-id");
  const storagePath = target.getAttribute("data-path");
  handleDelete(id, storagePath);
});

bookmarkToggleBtn.addEventListener("click", () => {
  if (!currentUser) {
    showToast("Login to view bookmarks");
    openModal(loginModal);
    return;
  }
  showOnlyBookmarks = !showOnlyBookmarks;
  bookmarkToggleBtn.textContent = showOnlyBookmarks ? "All Resources" : "Bookmarks";
  renderResources();
});

profileChip.addEventListener("click", () => {
  if (!currentUser) {
    showToast("Login to view your uploads");
    openModal(loginModal);
    return;
  }

  showOnlyMyUploads = !showOnlyMyUploads;
  profileChip.classList.toggle("active", showOnlyMyUploads);
  showToast(showOnlyMyUploads ? "Showing your uploads" : "Showing all uploads");
  renderResources();
});

onAuthStateChanged(
  auth,
  (user) => {
    authInitialized = true;
    if (localMode) {
      const stored = readLocalUser();
      currentUser = stored;
      setAuthUI(stored);
      renderResources();
      return;
    }
    currentUser = user;
    setAuthUI(user);
    renderResources();
  },
  (error) => {
    console.error(error);
    authInitialized = true;
    const stored = readLocalUser();
    currentUser = stored;
    setAuthUI(stored);
    enterLocalMode("Firebase Auth blocked. Using local mode.");
  }
);

subscribeResources();
bootstrapLocalResources();

window.setTimeout(() => {
  if (!authInitialized) {
    currentUser = readLocalUser();
    setAuthUI(currentUser);
    enterLocalMode("Firebase not responding. Local mode enabled.");
  }
}, 3500);
