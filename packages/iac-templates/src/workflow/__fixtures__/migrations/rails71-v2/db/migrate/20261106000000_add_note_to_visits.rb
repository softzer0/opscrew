class AddNoteToVisits < ActiveRecord::Migration[7.1]
  def change
    add_column :visits, :note, :text
  end
end
