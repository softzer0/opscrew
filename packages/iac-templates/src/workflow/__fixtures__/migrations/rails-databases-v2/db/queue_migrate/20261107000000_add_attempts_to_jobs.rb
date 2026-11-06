class AddAttemptsToJobs < ActiveRecord::Migration[8.1]
  def change
    add_column :jobs, :attempts, :integer
  end
end
