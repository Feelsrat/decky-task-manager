#!/usr/bin/env python3
"""
Create a cross-platform ZIP file for Decky plugin installation.
Uses forward slashes for compatibility with Linux.
"""

import zipfile
import os
import sys
from pathlib import Path

def create_plugin_zip(output_filename='decky-task-manager.zip'):
    """Create a ZIP file with proper cross-platform paths."""
    
    root_dir = Path(__file__).parent.parent
    zip_path = root_dir / output_filename
    
    # Remove old zip if exists
    if zip_path.exists():
        zip_path.unlink()
    
    # Files to include at root level
    root_files = [
        'plugin.json',
        'main.py',
        'defaults.py',
        'package.json',
        'README.md'
    ]
    
    # Check all required files exist
    for filename in root_files:
        file_path = root_dir / filename
        if not file_path.exists():
            print(f"❌ Error: {filename} not found")
            sys.exit(1)
    
    # Check dist folder exists
    dist_dir = root_dir / 'dist'
    if not dist_dir.exists():
        print("❌ Error: dist folder not found")
        sys.exit(1)
    
    # Create ZIP with forward slashes
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Add root files
        for filename in root_files:
            file_path = root_dir / filename
            # Use forward slash in ZIP regardless of OS
            zipf.write(file_path, filename)
            print(f"  Added: {filename}")
        
        # Add dist folder contents
        for file_path in dist_dir.rglob('*'):
            if file_path.is_file():
                # Create relative path with forward slashes
                relative_path = file_path.relative_to(root_dir)
                # Convert to POSIX path (forward slashes) for ZIP
                zip_path_str = relative_path.as_posix()
                zipf.write(file_path, zip_path_str)
                print(f"  Added: {zip_path_str}")
    
    print(f"\n✓ Created {output_filename}")
    return str(zip_path)

if __name__ == '__main__':
    try:
        create_plugin_zip()
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)
