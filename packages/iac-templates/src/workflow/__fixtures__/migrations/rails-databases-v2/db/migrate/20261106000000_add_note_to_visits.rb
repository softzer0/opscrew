class AddNoteToVisits < ActiveRecord::Migration[8.1]
  def change
    add_column :visits, :note, :text
  end
end
