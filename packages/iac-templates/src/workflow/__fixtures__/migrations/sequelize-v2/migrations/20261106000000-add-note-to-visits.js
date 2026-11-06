"use strict";

/** @type {import("sequelize-cli").Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("visits", "note", { type: Sequelize.TEXT });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("visits", "note");
  },
};
