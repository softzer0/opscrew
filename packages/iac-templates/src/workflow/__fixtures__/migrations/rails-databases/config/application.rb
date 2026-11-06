require_relative "boot"

require "rails"
require "active_record/railtie"

# A Rails app reduced to Active Record, whose migrations OpsCrew's down-migration test runs.
module Shop
  class Application < Rails::Application
    config.load_defaults 8.1
    config.eager_load = false
    config.logger = ActiveSupport::Logger.new($stderr)
    config.active_record.dump_schema_after_migration = false
  end
end
