import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
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
  BOOTSTRAP_ADMIN_EMAIL,
  DEFAULT_BRANCH_ID,
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
import {
  OperationType,
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  testConnection,
} from '../../services/firebase/config';
import { ensureDailySession } from '../../services/inventory/firestoreService';
import { ensureInitialSeedData } from '../../services/inventory/seedService';

interface FirebaseContextValue {
  firebaseUser: User | null;
  account: UserAccount | null;
  authLoading: boolean;
  authError: string | null;
  isAdmin: boolean;
  hasPermission: (perm: PermissionKey) => boolean;
  inventoryDate: string;
  setInventoryDate: (date: string) => void;
  activeBranchId: string;
  currentSession: DailySession | null;
  sessionLoading: boolean;
  categories: Category[];
  products: Product[];
  signInWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
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
  const [inventoryDate, setInventoryDate] = useState<string>(() => getTodayAdenDate());
  const [activeBranchId] = useState<string>(DEFAULT_BRANCH_ID);
  const [currentSession, setCurrentSession] = useState<DailySession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    void testConnection();
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setAuthError(null);
      if (!user) {
        setFirebaseUser(null);
        setAccount(null);
        setCurrentSession(null);
        setCategories([]);
        setProducts([]);
        setAuthLoading(false);
        return;
      }

      setFirebaseUser(user);
      setAuthLoading(true);

      try {
        const resolved = await resolveOrProvisionEmployee(user);

        if (resolved.status === 'active' && (resolved.role === 'ceo' || resolved.role === 'branch_manager')) {
          await ensureInitialSeedData(resolved);
        }

        setAccount(resolved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'تعذر تحميل بيانات الحساب.';
        setAuthError(msg);
      } finally {
        setAuthLoading(false);
      }
    });

    return () => unsub();
  }, []);

  // Subscribe to current user profile live updates (e.g. if admin activates or suspends them)
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

  // Subscribe to categories & products once account is active
  useEffect(() => {
    if (!account || account.status !== 'active') return;

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
  }, [account?.uid, account?.status, account?.role, account?.department, account?.permissions]);

  // Ensure and subscribe to dailySession for active inventoryDate
  useEffect(() => {
    if (!account || account.status !== 'active') {
      setCurrentSession(null);
      return;
    }

    let cancelled = false;
    setSessionLoading(true);
    const sessionId = `${activeBranchId}_${inventoryDate}`;

    ensureDailySession(account, activeBranchId, inventoryDate)
      .then((sess) => {
        if (!cancelled) setCurrentSession(sess);
      })
      .catch((err) => {
        console.error('Session error:', err);
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });

    const unsub = onSnapshot(
      doc(db, 'dailySessions', sessionId),
      (snap) => {
        if (snap.exists()) {
          setCurrentSession({ id: snap.id, ...(snap.data() as Omit<DailySession, 'id'>) });
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, `dailySessions/${sessionId}`)
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [account?.uid, account?.status, activeBranchId, inventoryDate]);

  const signInWithGoogle = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'فشل تسجيل الدخول بحساب Google';
      setAuthError(msg);
    }
  };

  const logout = async () => {
    await signOut(auth);
  };

  const refreshSession = async () => {
    if (!account || account.status !== 'active') return;
    const sess = await ensureDailySession(account, activeBranchId, inventoryDate);
    setCurrentSession(sess);
  };

  const isAdmin = useMemo(() => {
    return (
      !!account &&
      account.status === 'active' &&
      (account.role === 'ceo' || account.role === 'branch_manager')
    );
  }, [account]);

  const hasPermission = (perm: PermissionKey): boolean => {
    if (!account || account.status !== 'active') return false;
    if (isAdmin) return true;
    return account.permissions.includes(perm);
  };

  return (
    <FirebaseContext.Provider
      value={{
        firebaseUser,
        account,
        authLoading,
        authError,
        isAdmin,
        hasPermission,
        inventoryDate,
        setInventoryDate,
        activeBranchId,
        currentSession,
        sessionLoading,
        categories,
        products,
        signInWithGoogle,
        logout,
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
    if (
      emailLower === BOOTSTRAP_ADMIN_EMAIL &&
      (data.role !== 'ceo' || data.status !== 'active')
    ) {
      const perms = getDefaultPermissionsForRole('ceo');
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

  // Bootstrap Executive Admin
  if (emailLower === BOOTSTRAP_ADMIN_EMAIL) {
    const perms = getDefaultPermissionsForRole('ceo');
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
    await setDoc(userRef, {
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
    });

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
