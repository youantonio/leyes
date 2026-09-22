INSERT OR IGNORE INTO menu_items (id,name,category,price,description,sort_order) VALUES
('cafe-americano','Café americano','Café',55,'Café espresso con agua caliente',1),
('cafe-latte','Café latte','Café',75,'Espresso con leche vaporizada',2),
('cappuccino','Cappuccino','Café',78,'Espresso, leche y espuma',3),
('matcha','Matcha latte','Bebidas',85,'Matcha ceremonial con leche',4),
('te-chai','Chai latte','Bebidas',82,'Chai especiado con leche',5),
('croissant','Croissant','Alimentos',65,'Croissant de mantequilla',6),
('toast','Toast de aguacate','Alimentos',125,'Pan artesanal, aguacate y semillas',7),
('huevos','Huevos al gusto','Desayunos',120,'Huevos preparados al gusto',8),
('hotcakes','Hot cakes','Desayunos',135,'Hot cakes con fruta',9),
('ensalada','Ensalada RUSH','Alimentos',145,'Ensalada fresca de la casa',10);

INSERT OR IGNORE INTO tables (id,number,type,capacity,status) VALUES
('m1','M1','mesa',4,'available'),
('m2','M2','mesa',4,'available'),
('m3','M3','mesa',2,'available'),
('m4','M4','mesa',6,'available'),
('c1','C1','cancha',4,'available'),
('c2','C2','cancha',4,'available'),
('barra','BARRA','barra',6,'available');
