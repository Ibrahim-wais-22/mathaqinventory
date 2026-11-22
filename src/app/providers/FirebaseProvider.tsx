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
import { getTodayAdenDate } from '../../utils/dateAden';
import { normalizePhoneForPassword, verifyPassword } from '../../utils/passwordCrypto';
import {
  OperationType,
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  testConnection,
} from '../../services/firebase/config';
import { ensureDailySession, formatActionError } from '../../services/inventory/firestoreService';
import { ensureInitialSeedData } from '../../services/inventory/seedService';

const LOCK_STORAGE_KEY = 'mathaq_locked_uid';

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
  signInWithGoogle: () => Promise<void>;
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

  const [inventoryDate, setInventoryDate] = useState<string>(() => getTodayAdenDate());
  const [activeBranchId] = useState<string>(DEFAULT_BRANCH_ID);
  const [currentSession, setCurrentSession] = useState<DailySession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    void testConnection();
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
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

      setFirebaseUser(user);
      if (!credentialLoginInProgressRef.current) {
        setAuthLoading(true);
      }

      try {
        const resolved = await resolveOrProvisionEmployee(user);
        setAccount(resolved);

        if (!credentialLoginInProgressRef.current) {
          let lockedUid: string | null = null;
          try {
            lockedUid = window.localStorage.getItem(LOCK_STORAGE_KEY);
          } catch {
            lockedUid = null;
          }

          const unlocked = lockedUid !== user.uid;
          setIsCredentialUnlocked(unlocked);

          if (
            unlocked &&
            resolved.status === 'active' &&
            (resolved.role === 'ceo' || resolved.role === 'branch_manager')
          ) {
            await ensureInitialSeedData(resolved);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'تعذر تحميل بيانات الحساب.';
        setAuthError(msg);
      } finally {
        if (!credentialLoginInProgressRef.current) {
          setAuthLoading(false);
        }
      }
    });

    return () => unsub();
  }, []);

  // Subscribe to current user profile live updates (e.g. if admin activates, suspends, or updates credentials)
  useEffect(() => {
    if (!firebaseUser) return;
    const userRef = doc(db, 'users', firebaseUser.uid);
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        if (snap.exists()) {
          setAccount({ ...(snap.data() as UserAccount), uid: snap.id });
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

  // Ensure and subscribe to dailySession for active inventoryDate
  useEffect(() => {
    if (!account || account.status !== 'active' || !isCredentialUnlocked) {
      setCurrentSession(null);
      setSessionError(null);
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
  }, [account?.uid, account?.status, activeBranchId, inventoryDate, isCredentialUnlocked]);

  const clearAuthError = () => setAuthError(null);

  const signInWithGoogle = async () => {
    setAuthError(null);
    try {
      window.localStorage.removeItem(LOCK_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      if (cred.user) {
        const resolved = await resolveOrProvisionEmployee(cred.user);
        setFirebaseUser(cred.user);
        setAccount(resolved);
        setIsCredentialUnlocked(true);
        if (
          resolved.status === 'active' &&
          (resolved.role === 'ceo' || resolved.role === 'branch_manager')
        ) {
          await ensureInitialSeedData(resolved);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'فشل ربط البريد عبر Google.';
      setAuthError(msg);
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
          'لم يتم تعيين رقم الهاتف وكلمة المرور لهذا الحساب بعد. استخدم تبويب "التسجيل لأول مرة (ربط البريد)" للدخول وتحديث بيانات الحساب.'
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
        await ensureInitialSeedData(profile);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'تعذر تسجيل الدخول. يرجى المحاولة مجدداً.';
      setAuthError(msg);
    } finally {
      credentialLoginInProgressRef.current = false;
    }
  };

  const logout = async () => {
    setAuthError(null);
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
  const existingSnap = await getDoc(userRef);
  const tokenEmail = user.email || '';
  const emailLower = tokenEmail.trim().toLowerCase();

  if (existingSnap.exists()) {
    const data = { ...(existingSnap.data() as UserAccount), uid: existingSnap.id };
    const missingAnyOwnerPerm = ALL_PERMISSIONS.some((p) => !data.permissions?.includes(p));
    if (
      emailLower === BOOTSTRAP_ADMIN_EMAIL &&
      (data.role !== 'ceo' ||
        data.department !== 'management' ||
        data.status !== 'active' ||
        missingAnyOwnerPerm)
    ) {
      const perms = [...ALL_PERMISSIONS];
      const batch = writeBatch(db);
      batch.set(doc(db, 'admins', user.uid), {
        uid: user.uid,
        role: 'ceo',
        email: tokenEmail,
        createdAt: serverTimestamp(),
      });
      batch.update(userRef, {
        role: 'ceo',
        department: 'management',
        status: 'active',
        permissions: perms,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      return { ...data, role: 'ceo', department: 'management', status: 'active', permissions: perms };
    }
    return data;
  }

  // Bootstrap Executive Admin (Owner)
  if (emailLower === BOOTSTRAP_ADMIN_EMAIL) {
    const perms = [...ALL_PERMISSIONS];
    const newAdmin: Record<string, unknown> = {
      uid: user.uid,
      employeeNumber: 'EMP-001',
      username: emailLower.split('@')[0] || 'ceo',
      fullName: user.displayName || 'المدير التنفيذي — المذاق اليمني',
      email: tokenEmail,
      department: 'management',
      role: 'ceo',
      branchId: DEFAULT_BRANCH_ID,
      status: 'active',
      permissions: perms,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'admins', user.uid), {
      uid: user.uid,
      role: 'ceo',
      email: tokenEmail,
      createdAt: serverTimestamp(),
    });
    await setDoc(userRef, newAdmin);
    const created = await getDoc(userRef);
    return { ...(created.data() as UserAccount), uid: created.id };
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
