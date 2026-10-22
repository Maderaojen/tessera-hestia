// Root discovery can include release archives without isolated test state.
// Each package owns its test configuration and required setup files.
throw new Error('Run tests from a package directory, for example npm --prefix api test. Root test discovery is disabled.');
