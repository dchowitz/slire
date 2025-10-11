import { Firestore } from '@google-cloud/firestore';

// Firestore Emulator configuration
const FIRESTORE_HOST = 'localhost';
const FIRESTORE_PORT = 8080;
const PROJECT_ID = 'smart-repo-test';

class FirestoreFixture {
  private firestoreInstance?: Firestore;

  public get firestore(): Firestore {
    if (this.firestoreInstance) {
      return this.firestoreInstance;
    }
    throw new Error('Firestore not available, you need to run setup first');
  }

  public async setup() {
    if (!this.firestoreInstance) {
      // Configure Firestore to use the emulator (already running via Jest global setup)
      this.firestoreInstance = new Firestore({
        projectId: PROJECT_ID,
        host: FIRESTORE_HOST,
        port: FIRESTORE_PORT,
        ssl: false,
        customHeaders: {
          Authorization: 'Bearer owner',
        },
      });

      // Test connection by trying to get a dummy document
      // This should be immediate since emulator is already running
      await this.firestoreInstance
        .collection('_test')
        .doc('_connectivity')
        .get();
    }
  }

  public async teardown() {
    if (this.firestoreInstance) {
      try {
        // Properly close all connections
        await this.firestoreInstance.terminate();

        // Give it a moment to fully close
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.warn(
          'Firestore teardown failed:',
          error instanceof Error ? error.message : error
        );
        // Don't throw - teardown failures shouldn't break tests
      } finally {
        this.firestoreInstance = undefined; // Always clear instance
      }
    }
  }

  public async clearCollection(collectionName: string) {
    if (!this.firestoreInstance) {
      throw new Error('Firestore not available');
    }

    // Clear top-level collection
    const batch = this.firestoreInstance.batch();
    const snapshot = await this.firestoreInstance
      .collection(collectionName)
      .get();

    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    if (snapshot.size > 0) {
      await batch.commit();
    }

    // Also clear all subcollections with the same name via collection group (path-scoped tests)
    const groupSnap = await this.firestoreInstance
      .collectionGroup(collectionName)
      .get();
    if (!groupSnap.empty) {
      const groupBatch = this.firestoreInstance.batch();
      groupSnap.docs.forEach((doc) => {
        groupBatch.delete(doc.ref);
      });
      await groupBatch.commit();
    }
  }
}

const fixture = new FirestoreFixture();
export const firestore = fixture as Omit<
  FirestoreFixture,
  'setup' | 'teardown'
>;
export const setupFirestore = () => fixture.setup();
export const teardownFirestore = () => fixture.teardown();
export const clearFirestoreCollection = (collectionName: string) =>
  fixture.clearCollection(collectionName);
