import {
  doc,
  getDoc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import {
  DEFAULT_BRANCH_ID,
  DEFAULT_BRANCH_NAME,
  SEED_CATEGORIES,
  SEED_PRODUCTS,
  TIMEZONE,
} from '../../constants/departments';
import type { UserAccount } from '../../types/inventory';
import { OperationType, db, handleFirestoreError } from '../firebase/config';

/**
 * Idempotently seeds the main branch, systemSettings, the 4 core Yemeni food
 * categories, and the 12 approved starter products on first Admin sign-in.
 */
export async function ensureInitialSeedData(adminUser: UserAccount): Promise<void> {
  const settingsRef = doc(db, 'systemSettings', 'main');
  try {
    const snap = await getDoc(settingsRef);
    if (snap.exists() && snap.data()?.seeded === true) {
      return;
    }

    const batch = writeBatch(db);
    let writeCount = 0;

    const branchRef = doc(db, 'branches', DEFAULT_BRANCH_ID);
    const branchSnap = await getDoc(branchRef);
    if (!branchSnap.exists()) {
      batch.set(branchRef, {
        name: DEFAULT_BRANCH_NAME,
        code: 'MAIN_01',
        timezone: TIMEZONE,
        isActive: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      writeCount++;
    }

    for (const cat of SEED_CATEGORIES) {
      const catRef = doc(db, 'categories', cat.id);
      const catSnap = await getDoc(catRef);
      if (!catSnap.exists()) {
        batch.set(catRef, {
          name: cat.name,
          sortOrder: cat.sortOrder,
          isActive: true,
          createdBy: adminUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        writeCount++;
      }
    }

    for (const prod of SEED_PRODUCTS) {
      const prodRef = doc(db, 'products', prod.id);
      const prodSnap = await getDoc(prodRef);
      if (!prodSnap.exists()) {
        batch.set(prodRef, {
          name: prod.name,
          categoryId: prod.categoryId,
          unit: prod.unit,
          isActive: true,
          approvalStatus: 'approved',
          allowedDepartments: prod.allowedDepartments,
          createdBy: adminUser.uid,
          createdByName: adminUser.fullName.slice(0, 120),
          technicalApprovedBy: adminUser.uid,
          technicalApprovedByName: adminUser.fullName.slice(0, 120),
          adminApprovedBy: adminUser.uid,
          adminApprovedByName: adminUser.fullName.slice(0, 120),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        writeCount++;
      }
    }

    if (!snap.exists()) {
      batch.set(settingsRef, {
        timezone: TIMEZONE,
        activeBranchId: DEFAULT_BRANCH_ID,
        seeded: true,
        updatedBy: adminUser.uid,
        updatedAt: serverTimestamp(),
      });
      writeCount++;
    } else {
      batch.update(settingsRef, {
        timezone: TIMEZONE,
        activeBranchId: DEFAULT_BRANCH_ID,
        seeded: true,
        updatedBy: adminUser.uid,
        updatedAt: serverTimestamp(),
      });
      writeCount++;
    }

    if (writeCount > 0) {
      const auditRef = doc(db, 'auditLogs', `seed_${Date.now()}`);
      batch.set(auditRef, {
        branchId: DEFAULT_BRANCH_ID,
        department: 'management',
        actorUid: adminUser.uid,
        actorName: adminUser.fullName.slice(0, 120),
        actorRole: adminUser.role,
        action: 'تهيئة_البيانات_الأساسية',
        targetCollection: 'systemSettings',
        targetId: 'main',
        newValueSummary: `تهيئة ${SEED_CATEGORIES.length} مجموعات و${SEED_PRODUCTS.length} صنفاً معتمداً`,
        createdAt: serverTimestamp(),
      });
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'systemSettings/main');
  }
}
