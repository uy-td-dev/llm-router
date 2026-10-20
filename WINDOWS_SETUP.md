# Windows Build Setup

## MSVC Linker Required

Rust on Windows (MSVC target) requires Visual Studio Build Tools.

### Installation Steps

1. **Download VS Build Tools**:
   - Go to: https://visualstudio.microsoft.com/downloads/
   - Scroll to "All Downloads" → "Tools for Visual Studio"
   - Download "Build Tools for Visual Studio 2022"

2. **Install with C++ workload**:
   - Run the installer
   - Select "Desktop development with C++"
   - Install (requires ~6-8 GB)

3. **Restart terminal** after installation

4. **Verify installation**:
   ```powershell
   # Should show MSVC compiler path
   where link.exe
   ```

5. **Build the project**:
   ```powershell
   cargo build
   ```

### Alternative: GNU Toolchain (No VS Required)

If you don't want to install VS Build Tools (8GB+), use GNU toolchain instead:

```powershell
# Install GNU target
rustup target add x86_64-pc-windows-gnu

# Install MinGW
choco install mingw  # or download from mingw-w64.org
```

Then rebuild:
```powershell
cargo build --target x86_64-pc-windows-gnu
```

## After Installation

Once linker is available, run:

```bash
cargo build --release
```

The first build will take 5-10 minutes to compile all dependencies.
