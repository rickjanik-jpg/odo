# Registers Odo's Swift files with the Xcode project and sets the minimum iOS version.
# Runs on the cloud build Mac after scripts/patch-ios.js. Usage: ruby scripts/ios-add-files.rb ios/App/App.xcodeproj
require 'xcodeproj'

proj_path = ARGV[0] || 'ios/App/App.xcodeproj'
files = %w[MainViewController.swift OdoTrackerPlugin.swift Tracker.swift TripStore.swift Prefs.swift OdoIntents.swift]

project = Xcodeproj::Project.open(proj_path)
target = project.targets.find { |t| t.name == 'App' } or abort('ios-add-files: App target not found')

# Shortcuts actions need iOS 16 or newer.
target.build_configurations.each do |c|
  current = c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_s
  if current.empty? || Gem::Version.new(current) < Gem::Version.new('16.0')
    c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
  end
end

# Newer Xcode projects include every file in the App folder automatically.
synced = project.main_group.recursive_children.any? { |c| c.isa == 'PBXFileSystemSynchronizedRootGroup' }

unless synced
  group = project.main_group['App'] or abort('ios-add-files: App group not found')
  files.each do |name|
    next if group.files.any? { |f| f.path == name || f.display_name == name }
    abort("ios-add-files: missing ios/App/App/#{name}") unless File.exist?(File.join(File.dirname(proj_path), 'App', name))
    ref = group.new_reference(name)
    target.add_file_references([ref])
  end
end

project.save
puts "Odo files registered with Xcode#{synced ? ' (folder is synced automatically)' : ''}."
