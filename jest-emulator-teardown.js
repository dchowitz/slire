// Jest global teardown
module.exports = async () => {
  if (global.__EMULATOR_CLEANUP__) {
    console.log('🧹 Running emulator cleanup...');
    try {
      await global.__EMULATOR_CLEANUP__();
      console.log('✅ Emulator cleanup completed');
    } catch (error) {
      console.warn('⚠️ Emulator cleanup failed:', error.message);
    }
  }
};
