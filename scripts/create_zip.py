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
    plugin_folder = 'decky-task-manager'
    
    # Remove old zip if exists
    if zip_path.exists():
        zip_path.unlink()
    
    # Files to include
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
    
    # Create ZIP with files in subdirectory (Decky requirement: plugin.json must be at folder/plugin.json)
    print(f"\nCreating ZIP archive with files in '{plugin_folder}/' subdirectory...")
    print("(Decky expects: folder/plugin.json, NOT root-level plugin.json)\n")
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Add root files to subdirectory
        print(f"Adding files to {plugin_folder}/:")
        for filename in root_files:
            file_path = root_dir / filename
            # Add to subdirectory with forward slash
            zip_path_str = f"{plugin_folder}/{filename}"
            zipf.write(file_path, zip_path_str)
            info = zipf.getinfo(zip_path_str)
            print(f"  ✓ {zip_path_str} (size: {info.file_size} bytes)")
        
        # Add dist folder contents to subdirectory
        print(f"\nAdding dist folder to {plugin_folder}/dist/:")
        for file_path in dist_dir.rglob('*'):
            if file_path.is_file():
                # Create relative path with forward slashes inside subdirectory
                relative_path = file_path.relative_to(root_dir)
                zip_path_str = f"{plugin_folder}/{relative_path.as_posix()}"
                zipf.write(file_path, zip_path_str)
                info = zipf.getinfo(zip_path_str)
                print(f"  ✓ {zip_path_str} (size: {info.file_size} bytes)")
    
    print(f"\n✓ Created {output_filename}")
    print(f"\nVerifying ZIP contents:")
    with zipfile.ZipFile(zip_path, 'r') as zipf:
        print(f"Total files in ZIP: {len(zipf.namelist())}")
        print("\nAll ZIP entries (note: plugin.json must be in folder/):")
        for name in zipf.namelist():
            print(f"  - '{name}'")
        
        # Verify Decky requirement
        plugin_json_files = [f for f in zipf.namelist() if f.endswith('/plugin.json') and f.count('/') == 1]
        if len(plugin_json_files) == 1:
            print(f"\n✓ Decky validation passed: {plugin_json_files[0]} found (folder/plugin.json)")
        else:
            print(f"\n✗ WARNING: Decky expects exactly 1 'folder/plugin.json', found {len(plugin_json_files)}")
    
    return str(zip_path)

if __name__ == '__main__':
    try:
        create_plugin_zip()
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)
