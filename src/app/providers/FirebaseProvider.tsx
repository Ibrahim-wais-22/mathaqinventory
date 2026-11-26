import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  type User,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  ALL_PERMISSIONS,
  BOOTSTRAP_ADMIN_EMAIL,
  DEFAULT_BRANCH_ID,
  DEPARTMENT_OPERATION_PERMISSIONS,
  getDefaultPermissionsForRole,
} from '../../constants/departments';
import type {
  Category,
  DailySession,
  PermissionKey,
  Product,
  UserAccount,
  UserInvite,
} from '../../types/inventory';
import { getPreviousAdenDate, getTodayAdenDate, makeSessionId } from '../../utils/dateAden';
import { normalizePhoneForPassword, verifyPassword } from '../../utils/passwordCrypto';
import {
  OperationType,
  auth,
  authPersistenceReady,
  db,
  googleProvider,
  handleFirestoreError,
  testConnection,
} from '../../services/firebase/config';
import { ensureDailySession, formatActionError } from '../../services/inventory/firestoreService';
import { ensureInitialSeedData } from '../../services/inventory/seedService';

const LOCK_STORAGE_KEY = 'mathaq_locked_uid';
const CACHED_PROFILE_PREFIX = 'mathaq_profile_';

function saveCachedPublicProfile(acc: UserAccount): void {
  try {
    const publicProfile: UserAccount = {
      uid: acc.uid,
      employeeNumber: acc.employeeNumber,
      username: acc.username,
      fullName: acc.fullName,
      email: acc.email,
      department: acc.department,
      role: acc.role,
      branchId: acc.branchId,
      status: acc.status,
      permissions: Array.isArray(acc.permissions) ? acc.permissions : [],
    };
    window.localStorage.setItem(`${CACHED_PROFILE_PREFIX}${acc.uid}`, JSON.stringify(publicProfile));
  } catch {
    // ignore storage errors
  }
}

function loadCachedPublicProfile(uid: string): UserAccount | null {
  try {
    const raw = window.localStorage.getItem(`${CACHED_PROFILE_PREFIX}${uid}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserAccount;
    if (parsed && parsed.uid === uid && parsed.status) {
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function clearCachedPublicProfile(uid?: string): void {
  if (!uid) return;
  try {
    window.localStorage.removeItem(`${CACHED_PROFILE_PREFIX}${uid}`);
  } catch {
    // ignore
  }
}

function getAuthUserEmail(user: User | null | undefined): string {
  if (!user) return '';
  return (
    user.email ||
    user.providerData?.find((p) => !!p?.email)?.email ||
    ''
  ).trim();
}

function isBootstrapOwnerEmail(email?: string | null): boolean {
  return (email || '').trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
}

function formatAuthErrorMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: string } | null)?.code || '';
  if (code === 'auth/popup-blocked') {
    return 'تم حظر نافذة تسجيل الدخول المنبثقة من المتصفح. يرجى السماح بالنوافذ المنبثقة ثم المحاولة مجدداً.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'تم إغلاق نافذة Google قبل إتمام تسجيل الدخول.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'نطاق الموقع غير مصرح به في إعدادات مصادقة Firebase.';
  }
  if (code === 'auth/network-request-failed') {
    return 'تعذر الاتصال بالإنترنت أثناء تسجيل الدخول. تحقق من الشبكة وحاول مجدداً.';
  }
  return formatActionError(err, fallback);
}

interface FirebaseContextValue {
  firebaseUser: User | null;
  account: UserAccount | null;
  authLoading: boolean;
  authError: string | null;
  clearAuthError: () => void;
  isCredentialUnlocked: boolean;
  linkedEmail: string | null;
  isAdmin: boolean;
  isDeptQtyReadOnly: boolean;
  hasPermission: (perm: PermissionKey) => boolean;
  inventoryDate: string;
  setInventoryDate: (date: string) => void;
  activeBranchId: string;
  currentSession: DailySession | null;
  sessionLoading: boolean;
  sessionError: string | null;
  categories: Category[];
  products: Product[];
  signInWithGoogle: (hasConsent?: boolean) => Promise<'ok' | 'already_active' | 'error'>;
  signInWithCredentials: (employeeNumber: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  unlinkGoogleAccount: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) throw new Error('useFirebase must be used inside FirebaseProvider');
  return ctx;
}

export const FirebaseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [account, setAccount] = useState<UserAccount | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isCredentialUnlocked, setIsCredentialUnlocked] = useState(false);
  const credentialLoginInProgressRef = useRef(false);

  const [inventoryDate, setInventoryDateState] = useState<string>(() => getTodayAdenDate());
  const [defaultDateResolved, setDefaultDateResolved] = useState(false);
  const hasManuallySelectedDateRef = useRef(false);
  const autoDateCheckedForUidRef = useRef<string | null>(null);
  const [activeBranchId] = useState<string>(DEFAULT_BRANCH_ID);
  const [currentSession, setCurrentSession] = useState<DailySession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const setInventoryDate = (date: string) => {
    if (!date) return;
    hasManuallySelectedDateRef.current = true;
    setDefaultDateResolved(true);
    setInventoryDateState(date);
  };

  useEffect(() => {
    void testConnection();
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;

    const initAuth = async () => {
      await authPersistenceReady;
      if (typeof auth.authStateReady === 'function') {
        try {
          await auth.authStateReady();
        } catch {
          // ignore authStateReady error
        }
      }
      if (cancelled) return;

      unsub = onAuthStateChanged(auth, async (user) => {
        if (cancelled) return;
        if (!credentialLoginInProgressRef.current) {
          setAuthError(null);
        }

        if (!user) {
          setFirebaseUser(null);
          setAccount(null);
          setIsCredentialUnlocked(false);
          setCurrentSession(null);
          setCategories([]);
          setProducts([]);
          setAuthLoading(false);
          return;
        }

        if (credentialLoginInProgressRef.current) {
          return;
        }

        setFirebaseUser(user);
        setAuthLoading(true);

        try {
          const resolved = await resolveOrProvisionEmployee(user);
          if (cancelled) return;
          saveCachedPublicProfile(resolved);
          setAccount(resolved);

          if (!credentialLoginInProgressRef.current) {
            const authEmail = getAuthUserEmail(user);
            const isOwnerEmail =
              isBootstrapOwnerEmail(authEmail) || isBootstrapOwnerEmail(resolved.email);

            let unlocked = true;
            if (isOwnerEmail) {
              try {
                window.localStorage.removeItem(LOCK_STORAGE_KEY);
              } catch {
                // ignore storage errors
              }
              unlocked = true;
            } else {
              let lockedUid: string | null = null;
              try {
                lockedUid = window.localStorage.getItem(LOCK_STORAGE_KEY);
              } catch {
                lockedUid = null;
              }
              unlocked = lockedUid !== user.uid;
            }

            setIsCredentialUnlocked(unlocked);

            if (
              unlocked &&
              resolved.status === 'active' &&
              (resolved.role === 'ceo' || resolved.role === 'branch_manager')
            ) {
              try {
                await ensureInitialSeedData(resolved);
              } catch (seedErr) {
                console.warn('Initial seed warning:', seedErr);
              }
            }
          }
        } catch (err) {
          if (!cancelled) {
            setAuthError(formatAuthErrorMessage(err, 'تعذر تحميل بيانات الحساب.'));
          }
        } finally {
          if (!cancelled && !credentialLoginInProgressRef.current) {
            setAuthLoading(false);
          }
        }
      });
    };

    void initAuth();

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, []);

  // Subscribe to current user profile live updates (e.g. if admin activates, suspends, or updates credentials)
  useEffect(() => {
    if (!firebaseUser) return;
    const userRef = doc(db, 'users', firebaseUser.uid);
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        if (snap.exists()) {
          const nextAcc = { ...(snap.data() as UserAccount), uid: snap.id };
          saveCachedPublicProfile(nextAcc);
          setAccount(nextAcc);
          if (
            isBootstrapOwnerEmail(getAuthUserEmail(firebaseUser)) ||
            isBootstrapOwnerEmail(nextAcc.email)
          ) {
            setIsCredentialUnlocked(true);
          }
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
      }
    );
    return () => unsub();
  }, [firebaseUser]);

  // Subscribe to categories & products once account is active and unlocked
  useEffect(() => {
    if (!account || account.status !== 'active' || !isCredentialUnlocked) return;

    const catQ = query(collection(db, 'categories'), orderBy('sortOrder', 'asc'));
    const unsubCats = onSnapshot(
      catQ,
      (snap) => {
        setCategories(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Category, 'id'>) })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'categories')
    );

    const unrestrictedProducts =
      account.role === 'ceo' ||
      account.role === 'branch_manager' ||
      account.department === 'production' ||
      account.permissions.includes('manage_catalog');

    const prodQ = unrestrictedProducts
      ? query(collection(db, 'products'))
      : query(collection(db, 'products'), where('approvalStatus', '==', 'approved'));

    const unsubProds = onSnapshot(
      prodQ,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Product, 'id'>) }))
          .filter(
            (p) =>
              unrestrictedProducts ||
              (account.department !== 'management' &&
                p.allowedDepartments.includes(account.department))
          );
        setProducts(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'products')
    );

    return () => {
      unsubCats();
      unsubProds();
    };
  }, [account?.uid, account?.status, account?.role, account?.department, account?.permissions, isCredentialUnlocked]);

  // Resolve initial inventory date for next-morning workflow:
  // If yesterday's session is not yet closed, default to yesterday so staff record morning reports on the right day.
  useEffect(() => {
    if (!account || account.status !== 'active' || !isCredentialUnlocked) {
      autoDateCheckedForUidRef.current = null;
      hasManuallySelectedDateRef.current = false;
      setDefaultDateResolved(false);
      return;
    }

    if (hasManuallySelectedDateRef.current || autoDateCheckedForUidRef.current === account.uid) {
      setDefaultDateResolved(true);
      return;
    }

    let cancelled = false;
    const today = getTodayAdenDate();
    const yesterday = getPreviousAdenDate(today);
    const yesterdaySessionId = makeSessionId(activeBranchId, yesterday);

    getDoc(doc(db, 'dailySessions', yesterdaySessionId))
      .then((snap) => {
        if (cancelled) return;
        autoDateCheckedForUidRef.current = account.uid;
        if (!hasManuallySelectedDateRef.current) {
          const isYesterdayClosed = snap.exists() && snap.data()?.status === 'closed';
          setInventoryDateState(isYesterdayClosed ? today : yesterday);
        }
        setDefaultDateResolved(true);
      })
      .catch(() => {
        if (cancelled) return;
        autoDateCheckedForUidRef.current = account.uid;
        setDefaultDateResolved(true);
      });

    return () => {
      cancelled = true;
    };
  }, [account?.uid, account?.status, activeBranchId, isCredentialUnlocked]);

  // Ensure and subscribe to dailySession for active inventoryDate
  useEffect(() => {
    if (!account || account.status !== 'active' || !isCredentialUnlocked) {
      setCurrentSession(null);
      setSessionError(null);
      return;
    }
    if (!defaultDateResolved) {
      return;
    }

    let cancelled = false;
    setSessionLoading(true);
    setSessionError(null);
    const sessionId = `${activeBranchId}_${inventoryDate}`;

    ensureDailySession(account, activeBranchId, inventoryDate)
      .then((sess) => {
        if (!cancelled) {
          setCurrentSession(sess);
          setSessionError(null);
        }
      })
      .catch((err) => {
        console.error('Session error:', err);
        if (!cancelled) {
          setSessionError(
            formatActionError(
              err,
              'تعذر فتح جلسة الجرد اليومية. تأكد من تهيئة بيانات الفرع وصلاحيات الحساب.'
            )
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });

    const unsub = onSnapshot(
      doc(db, 'dailySessions', sessionId),
      (snap) => {
        if (snap.exists()) {
          setCurrentSession({ id: snap.id, ...(snap.data() as Omit<DailySession, 'id'>) });
          setSessionError(null);
        }
      },
      (err) => {
        if (!cancelled) {
          setSessionError(formatActionError(err, 'تعذر متابعة جلسة الجرد اليومية.'));
        }
        handleFirestoreError(err, OperationType.GET, `dailySessions/${sessionId}`);
      }
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [account?.uid, account?.status, activeBranchId, inventoryDate, isCredentialUnlocked, defaultDateResolved]);

  const clearAuthError = () => setAuthError(null);

  const signInWithGoogle = async (
    hasConsent = false
  ): Promise<'ok' | 'already_active' | 'error'> => {
    setAuthError(null);
    credentialLoginInProgressRef.current = true;
    try {
      await authPersistenceReady;
      const cred = await signInWithPopup(auth, googleProvider);
      const user = cred.user;
      if (!user) return 'error';

      const tokenEmail = getAuthUserEmail(user);
      const isOwner = isBootstrapOwnerEmail(tokenEmail);

      // Owner email enters directly without consent or registration steps
      if (isOwner) {
        try {
          window.localStorage.removeItem(LOCK_STORAGE_KEY);
        } catch {
          // ignore storage errors
        }
        const resolved = await resolveOrProvisionEmployee(user);
        saveCachedPublicProfile(resolved);
        setFirebaseUser(user);
        setAccount(resolved);
        setIsCredentialUnlocked(true);
        try {
          await ensureInitialSeedData(resolved);
        } catch (seedErr) {
          console.warn('Initial seed warning:', seedErr);
        }
        return 'ok';
      }

      // Check if non-owner user already has an active profile before allowing first-time link bypass
      const existingSnap = await getDoc(doc(db, 'users', user.uid));
      if (existingSnap.exists()) {
        const existingProfile = {
          ...(existingSnap.data() as UserAccount),
          uid: existingSnap.id,
        };
        if (existingProfile.status === 'active') {
          try {
            window.localStorage.setItem(LOCK_STORAGE_KEY, user.uid);
          } catch {
            // ignore
          }
          saveCachedPublicProfile(existingProfile);
          setFirebaseUser(user);
          setAccount(existingProfile);
          setIsCredentialUnlocked(false);
          setAuthError('هذا الحساب مسجل ومفعّل مسبقاً. أدخل الرقم الوظيفي وكلمة المرور للدخول.');
          return 'already_active';
        }
      }

      // New or pending employee must consent to link their email before submitting a join request
      if (!hasConsent) {
        await signOut(auth);
        setFirebaseUser(null);
        setAccount(null);
        setIsCredentialUnlocked(false);
        setAuthError('يرجى الموافقة على ربط البريد الإلكتروني أولاً لإرسال طلب الانضمام.');
        return 'error';
      }

      try {
        window.localStorage.removeItem(LOCK_STORAGE_KEY);
      } catch {
        // ignore storage errors
      }
      const resolved = await resolveOrProvisionEmployee(user);
      saveCachedPublicProfile(resolved);
      setFirebaseUser(user);
      setAccount(resolved);
      setIsCredentialUnlocked(true);
      if (
        resolved.status === 'active' &&
        (resolved.role === 'ceo' || resolved.role === 'branch_manager')
      ) {
        try {
          await ensureInitialSeedData(resolved);
        } catch (seedErr) {
          console.warn('Initial seed warning:', seedErr);
        }
      }
      return 'ok';
    } catch (err) {
      setAuthError(formatAuthErrorMessage(err, 'فشل ربط البريد عبر Google.'));
      return 'error';
    } finally {
      credentialLoginInProgressRef.current = false;
    }
  };

  const signInWithCredentials = async (employeeNumber: string, password: string) => {
    setAuthError(null);
    const empClean = employeeNumber.trim();
    const passClean = password.trim();

    if (!empClean || !passClean) {
      setAuthError('يرجى إدخال الرقم الوظيفي وكلمة المرور.');
      return;
    }

    credentialLoginInProgressRef.current = true;
    try {
      await authPersistenceReady;
      let user = auth.currentUser;
      let profile = account;

      if (!user) {
        const cred = await signInWithPopup(auth, googleProvider);
        user = cred.user;
        setFirebaseUser(user);
      }

      if (!profile || profile.uid !== user.uid) {
        profile = await resolveOrProvisionEmployee(user);
        setAccount(profile);
      }

      if (isBootstrapOwnerEmail(getAuthUserEmail(user)) || isBootstrapOwnerEmail(profile.email)) {
        try {
          window.localStorage.removeItem(LOCK_STORAGE_KEY);
        } catch {
          // ignore
        }
        setIsCredentialUnlocked(true);
        setAuthError(null);
        try {
          await ensureInitialSeedData(profile);
        } catch (seedErr) {
          console.warn('Initial seed warning:', seedErr);
        }
        return;
      }

      if (profile.status !== 'active') {
        try {
          window.localStorage.removeItem(LOCK_STORAGE_KEY);
        } catch {
          // ignore
        }
        setIsCredentialUnlocked(true);
        return;
      }

      const expectedEmp = (profile.employeeNumber || '').trim().toLowerCase();
      if (empClean.toLowerCase() !== expectedEmp) {
        try {
          window.localStorage.setItem(LOCK_STORAGE_KEY, user.uid);
        } catch {
          // ignore
        }
        setIsCredentialUnlocked(false);
        setAuthError('الرقم الوظيفي أو كلمة المرور غير صحيحة.');
        return;
      }

      let passwordValid = false;
      if (profile.passwordHash && profile.passwordSalt) {
        passwordValid = await verifyPassword(passClean, profile.passwordSalt, profile.passwordHash);
        if (!passwordValid) {
          const normalizedPhonePass = normalizePhoneForPassword(password);
          if (normalizedPhonePass && normalizedPhonePass !== passClean) {
            passwordValid = await verifyPassword(
              normalizedPhonePass,
              profile.passwordSalt,
              profile.passwordHash
            );
          }
        }
      } else if (profile.phoneNumber) {
        passwordValid =
          normalizePhoneForPassword(password) === normalizePhoneForPassword(profile.phoneNumber);
      } else {
        try {
          window.localStorage.setItem(LOCK_STORAGE_KEY, user.uid);
        } catch {
          // ignore
        }
        setIsCredentialUnlocked(false);
        setAuthError(
          'لم يتم تعيين رقم الهاتف وكلمة المرور لهذا الحساب بعد. استخدم تبويب "أول مرة" لربط البريد وتحديث بيانات الحساب.'
        );
        return;
      }

      if (!passwordValid) {
        try {
          window.localStorage.setItem(LOCK_STORAGE_KEY, user.uid);
        } catch {
          // ignore
        }
        setIsCredentialUnlocked(false);
        setAuthError('الرقم الوظيفي أو كلمة المرور غير صحيحة.');
        return;
      }

      try {
        window.localStorage.removeItem(LOCK_STORAGE_KEY);
      } catch {
        // ignore
      }
      setIsCredentialUnlocked(true);
      setAuthError(null);

      if (profile.role === 'ceo' || profile.role === 'branch_manager') {
        try {
          await ensureInitialSeedData(profile);
        } catch (seedErr) {
          console.warn('Initial seed warning:', seedErr);
        }
      }
    } catch (err) {
      setAuthError(formatAuthErrorMessage(err, 'تعذر تسجيل الدخول. يرجى المحاولة مجدداً.'));
    } finally {
      credentialLoginInProgressRef.current = false;
    }
  };

  const logout = async () => {
    setAuthError(null);
    if (isBootstrapOwnerEmail(firebaseUser?.email || account?.email)) {
      await unlinkGoogleAccount();
      return;
    }
    if (firebaseUser) {
      try {
        window.localStorage.setItem(LOCK_STORAGE_KEY, firebaseUser.uid);
      } catch {
        // ignore
      }
    }
    setIsCredentialUnlocked(false);
    setCurrentSession(null);
    setCategories([]);
    setProducts([]);
  };

  const unlinkGoogleAccount = async () => {
    setAuthError(null);
    clearCachedPublicProfile(firebaseUser?.uid || account?.uid);
    try {
      window.localStorage.removeItem(LOCK_STORAGE_KEY);
    } catch {
      // ignore
    }
    setIsCredentialUnlocked(false);
    setCurrentSession(null);
    setCategories([]);
    setProducts([]);
    await signOut(auth);
  };

  const refreshSession = async () => {
    if (!account || account.status !== 'active' || !isCredentialUnlocked) return;
    setSessionError(null);
    setSessionLoading(true);
    try {
      const sess = await ensureDailySession(account, activeBranchId, inventoryDate);
      setCurrentSession(sess);
    } catch (err) {
      setSessionError(formatActionError(err, 'تعذر تحديث جلسة الجرد اليومية.'));
    } finally {
      setSessionLoading(false);
    }
  };

  const isBootstrapOwner = useMemo(() => {
    return (
      !!account &&
      account.status === 'active' &&
      (account.email || '').trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL
    );
  }, [account]);

  const isAdmin = useMemo(() => {
    return (
      !!account &&
      account.status === 'active' &&
      (account.role === 'ceo' || account.role === 'branch_manager')
    );
  }, [account]);

  const isDeptQtyReadOnly = useMemo(() => {
    if (isBootstrapOwner) return false;
    return !!account && (account.role === 'ceo' || account.role === 'branch_manager');
  }, [account, isBootstrapOwner]);

  const hasPermission = (perm: PermissionKey): boolean => {
    if (!account || account.status !== 'active') return false;
    if (isBootstrapOwner) return true;
    if (isAdmin) {
      if (DEPARTMENT_OPERATION_PERMISSIONS.includes(perm)) {
        return false;
      }
      return true;
    }
    return account.permissions.includes(perm);
  };

  return (
    <FirebaseContext.Provider
      value={{
        firebaseUser,
        account,
        authLoading,
        authError,
        clearAuthError,
        isCredentialUnlocked,
        linkedEmail: firebaseUser?.email || account?.email || null,
        isAdmin,
        isDeptQtyReadOnly,
        hasPermission,
        inventoryDate,
        setInventoryDate,
        activeBranchId,
        currentSession,
        sessionLoading,
        sessionError,
        categories,
        products,
        signInWithGoogle,
        signInWithCredentials,
        logout,
        unlinkGoogleAccount,
        refreshSession,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
};

async function resolveOrProvisionEmployee(user: User): Promise<UserAccount> {
  const userRef = doc(db, 'users', user.uid);
  const tokenEmail = getAuthUserEmail(user) || '';
  const emailLower = tokenEmail.toLowerCase();
  const isOwner = emailLower === BOOTSTRAP_ADMIN_EMAIL;

  let existingSnap;
  try {
    existingSnap = await getDoc(userRef);
  } catch (err) {
    if (isOwner) {
      return {
        uid: user.uid,
        employeeNumber: 'EMP-001',
        username: 'mathaqinventory',
        fullName: (user.displayName || 'المدير التنفيذي — المذاق اليمني').slice(0, 120),
        email: tokenEmail || BOOTSTRAP_ADMIN_EMAIL,
        department: 'management',
        role: 'ceo',
        branchId: DEFAULT_BRANCH_ID,
        status: 'active',
        permissions: [...ALL_PERMISSIONS],
      };
    }
    const cached = loadCachedPublicProfile(user.uid);
    if (cached) {
      return cached;
    }
    throw err;
  }

  if (existingSnap.exists()) {
    const data = { ...(existingSnap.data() as UserAccount), uid: existingSnap.id };
    const missingAnyOwnerPerm = ALL_PERMISSIONS.some((p) => !data.permissions?.includes(p));
    if (
      isOwner &&
      (data.role !== 'ceo' ||
        data.department !== 'management' ||
        data.status !== 'active' ||
        missingAnyOwnerPerm)
    ) {
      const perms = [...ALL_PERMISSIONS];
      try {
        const adminRef = doc(db, 'admins', user.uid);
        const adminSnap = await getDoc(adminRef);
        const batch = writeBatch(db);
        if (!adminSnap.exists()) {
          batch.set(adminRef, {
            uid: user.uid,
            role: 'ceo',
            email: tokenEmail || BOOTSTRAP_ADMIN_EMAIL,
            createdAt: serverTimestamp(),
          });
        }
        batch.update(userRef, {
          role: 'ceo',
          department: 'management',
          status: 'active',
          permissions: perms,
          updatedAt: serverTimestamp(),
        });
        await batch.commit();
      } catch (err) {
        console.warn('Owner profile sync warning:', err);
      }
      return { ...data, role: 'ceo', department: 'management', status: 'active', permissions: perms };
    }
    return data;
  }

  // Bootstrap Executive Admin (Owner)
  if (isOwner) {
    const perms = [...ALL_PERMISSIONS];
    const ownerEmail = tokenEmail || BOOTSTRAP_ADMIN_EMAIL;
    const ownerUsername = (emailLower.split('@')[0] || 'ceo').slice(0, 80);
    const ownerFullName = (user.displayName || 'المدير التنفيذي — المذاق اليمني').slice(0, 120);
    const newAdmin: Record<string, unknown> = {
      uid: user.uid,
      employeeNumber: 'EMP-001',
      username: ownerUsername,
      fullName: ownerFullName,
      email: ownerEmail,
      department: 'management',
      role: 'ceo',
      branchId: DEFAULT_BRANCH_ID,
      status: 'active',
      permissions: perms,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    try {
      const adminRef = doc(db, 'admins', user.uid);
      const adminSnap = await getDoc(adminRef);
      if (!adminSnap.exists()) {
        await setDoc(adminRef, {
          uid: user.uid,
          role: 'ceo',
          email: ownerEmail,
          createdAt: serverTimestamp(),
        });
      }
    } catch (adminErr) {
      console.warn('Owner admins doc check warning:', adminErr);
    }
    try {
      await setDoc(userRef, newAdmin);
      const created = await getDoc(userRef);
      if (created.exists()) {
        return { ...(created.data() as UserAccount), uid: created.id };
      }
    } catch (userErr) {
      console.warn('Owner user doc create warning:', userErr);
    }
    return {
      uid: user.uid,
      employeeNumber: 'EMP-001',
      username: ownerUsername,
      fullName: ownerFullName,
      email: ownerEmail,
      department: 'management',
      role: 'ceo',
      branchId: DEFAULT_BRANCH_ID,
      status: 'active',
      permissions: perms,
    };
  }

  // Check if pre-invited by Executive Admin
  const invitesSnap = await getDocs(
    query(collection(db, 'userInvites'), where('email', '==', tokenEmail))
  );
  let unclaimedDoc = invitesSnap.docs.find((d) => d.data()?.claimed === false);
  if (!unclaimedDoc && emailLower !== tokenEmail) {
    const lowerSnap = await getDocs(
      query(collection(db, 'userInvites'), where('email', '==', emailLower))
    );
    unclaimedDoc = lowerSnap.docs.find((d) => d.data()?.claimed === false);
  }

  if (unclaimedDoc) {
    const inv = { id: unclaimedDoc.id, ...(unclaimedDoc.data() as Omit<UserInvite, 'id'>) };
    const inviteUserPayload: Record<string, unknown> = {
      uid: user.uid,
      employeeNumber: inv.employeeNumber,
      username: inv.username,
      fullName: inv.fullName || user.displayName || tokenEmail,
      email: tokenEmail,
      department: inv.department,
      role: inv.role,
      branchId: inv.branchId,
      status: inv.status,
      permissions: inv.permissions,
      inviteId: inv.id,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (inv.phoneNumber) inviteUserPayload.phoneNumber = inv.phoneNumber;
    if (inv.passwordSalt) inviteUserPayload.passwordSalt = inv.passwordSalt;
    if (inv.passwordHash) inviteUserPayload.passwordHash = inv.passwordHash;

    await setDoc(userRef, inviteUserPayload);

    await updateDoc(doc(db, 'userInvites', inv.id), {
      claimed: true,
      updatedAt: serverTimestamp(),
    });

    if ((inv.role === 'ceo' || inv.role === 'branch_manager') && inv.status === 'active') {
      await setDoc(doc(db, 'admins', user.uid), {
        uid: user.uid,
        role: inv.role,
        email: tokenEmail,
        createdAt: serverTimestamp(),
      });
    }

    const created = await getDoc(userRef);
    return { ...(created.data() as UserAccount), uid: created.id };
  }

  // Unrecognized user -> pending_activation
  await setDoc(userRef, {
    uid: user.uid,
    employeeNumber: `NEW-${String(Date.now()).slice(-4)}`,
    username: emailLower.split('@')[0] || 'employee',
    fullName: user.displayName || tokenEmail || 'موظف جديد',
    email: tokenEmail,
    department: 'factory',
    role: 'pending',
    branchId: DEFAULT_BRANCH_ID,
    status: 'pending_activation',
    permissions: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const created = await getDoc(userRef);
  return { ...(created.data() as UserAccount), uid: created.id };
}
