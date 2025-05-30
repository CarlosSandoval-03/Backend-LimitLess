import { RequestHandler } from "express";
import createHttpError from "http-errors";
import { PropertyModel } from "../../models/properties/property";
import { PropertyMediaModel } from "../../models/properties/propertyMedia";
import { TenantModel } from "../../models/users/tenant";
import { uploadFileS3 } from "../../utils/S3";
import { ContractModel } from "../../models/contract/contract";
import { addFiltersToQuery, filterResponseByRegex, getObjectsByIds } from "../../utils/mongoQueryUtils";
import { Types } from "mongoose";


export const createProperty: RequestHandler = async (req, res, next) => {
  const {
    address,
    city,
    state,
    type,
    rooms,
    parking,
    squareMeters,
    tier,
    bathrooms,
    age,
    floors,
    description,
    landlordAuthID,
  } = req.body;
  const files = req.files?.files; // Array de archivos multimedia
  try {
    // Crear la propiedad
    const newProperty = await PropertyModel.create({
      address,
      city,
      state,
      type,
      rooms,
      parking,
      squareMeters,
      tier,
      bathrooms,
      age,
      floors,
      description,
      landlordAuthID,
    });

    // Manejar los archivos multimedia
    if (files && Array.isArray(files)) {
      const mediaPromises = files.map(async (file: any) => {
        // Subir archivo a S3
        const s3Result = await uploadFileS3(file);
        console.log(s3Result)

        // Crear el documento PropertyMedia con referencia a la propiedad
        return await PropertyMediaModel.create({
          property: newProperty._id,
          mediaType: file.mimetype,
          mediaUrl: s3Result,
          description: file.description || "",
          uploadDate: new Date()
        });
      });

      // Esperar a que todas las promesas terminen
      await Promise.all(mediaPromises);
    }
    else {
      throw new Error(`Failed to upload file, there's no file to upload`);
    }

    res.status(201).json({
      message: "Property created successfully",
      property: newProperty,
    });
  } catch (error) {
    if ((error as any).name === "ValidationError") {
      // Manejo de errores de validación de Mongoose
      const validationErrors = Object.values((error as any).errors).map(
        (err: any) => ({
          field: err.path,
          message: err.message,
        })
      );
      res.status(400).json({
        message: "Validation failed",
        errors: validationErrors,
      });
      return; // Asegurarse de no continuar después de enviar una respuesta
    }

    // Registrar otros errores para depuración
    console.error(error);

    // Pasar el error a otros middlewares
    next(error);
  }
};

export const updateProperty: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updatedData = req.body;

    const updatedProperty = await PropertyModel.findByIdAndUpdate(
      id,
      updatedData,
      {
        new: true,
      }
    ).exec();

    if (!updatedProperty) {
      throw createHttpError(404, `Property with ID ${id} not found`);
    }

    res.status(200).json(updatedProperty);
  } catch (error) {
    next(error);
  }
};

export const deleteProperty: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params;

    const deletedProperty = await PropertyModel.findByIdAndDelete(id).exec();
    if (!deletedProperty) {
      throw createHttpError(404, `Property with ID ${id} not found`);
    }

    res.status(200).json("Property successfully deleted");
  } catch (error) {
    next(error);
  }
};

export const showProperty: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params;
    const propertyObjectId = new Types.ObjectId(id);

    // Buscar la propiedad por ID
    const property = await PropertyModel.findById(id).exec();
    if (!property) {
      throw createHttpError(404, `Property with ID ${id} not found`);
    }

    // Buscar los medios asociados a la propiedad
    const media = await PropertyMediaModel.find({ property: id }).exec();

    const contract = await ContractModel.findOne({
      propertyId: propertyObjectId,
      status: "active"
    }).exec();

    if (contract) {
      const tenant = await TenantModel.findOne({ authID: contract.tenantAuthID })
        .select("firstName email authID")
        .exec();

      contract.set("tenant", tenant || null, { strict: false });
    }
    res.status(200).json({ property, media, contract });
  } catch (error) {
    next(error);
  }
};

export const showProperties: RequestHandler = async (req, res, next) => {
  try {
    console.log("Fetching properties");
    const properties = await PropertyModel.find().exec();
    if (!properties || properties.length === 0) {
      throw createHttpError(404, "No properties found");
    }

    res.status(200).json(properties);
  } catch (error) {
    console.error(error);
    next(error);
  }
};

export const showPropertiesByUser: RequestHandler = async (req, res, next) => {
  const { userId } = req.params;

  try {
    // Buscar propiedades asociadas al usuario
    const properties = await PropertyModel.find({
      landlordAuthID: userId,
    }).exec();
    if (!properties || properties.length === 0) {
      throw createHttpError(404, "No properties found");
    }

    // Mapear propiedades con sus respectivos medios
    const propertiesWithMedia = await Promise.all(
      properties.map(async (property) => {
        const propertyObjectId = new Types.ObjectId(property._id);

        const media = await PropertyMediaModel.find({
          property: property._id,
        }).exec();

        const contract = await ContractModel.findOne({
          propertyId: propertyObjectId,
          status: "active",
        })
          .exec();

        return { ...property.toObject(), media, contract };
      })
    );

    // Enviar las propiedades con sus medios
    res.status(200).json(propertiesWithMedia);
  } catch (error) {
    next(error);
  }
};

export const showAvailableProperties: RequestHandler = async (req, res, next) => {
  const regexFields = ["address", "city", "state", "type", "description"];
  const exactFields = ["rooms", "parking", "squareMeters", "tier", "bathrooms", "age", "floors", "isAvailable"];
  const filter = addFiltersToQuery(req.body, exactFields);

  try {
    const properties = await PropertyModel.aggregate()
      .match({ ...filter })
      .project({ createdAt: 0, updatedAt: 0, __v: 0 }) // Retornar todo menos los timestamps y metadata de mongoose
      .lookup({ from: "propertymedias", localField: "_id", foreignField: "property", as: "propertyMedia" }) // Se usa el nombre de la colección en la base de datos
      .addFields({
        // Eliminar campos no deseados de cada propertyMedia
        propertyMedia: {
          $map: {
            input: "$propertyMedia",
            as: "media",
            in: {
              mediaUrl: "$$media.mediaUrl",
              mediaType: "$$media.mediaType",
              description: "$$media.description",
              uploadDate: "$$media.uploadDate",
            },
          },
        },
      })
      .sort({ createdAt: -1 })
      .exec();

    // Se obtienen los IDs de las propiedades que cumplen con los filtros y se usara una función distinta
    // para que las normalizaciones aplicadas a los campos de texto no afecten los resultados de la búsqueda
    const filteredPropertiesIds = filterResponseByRegex(properties, regexFields, req.body);
    const filteredProperties = getObjectsByIds(properties, filteredPropertiesIds);
    if (!filteredProperties || filteredProperties.length === 0) {
      throw createHttpError(404, "No properties found");
    }

    res.status(200).json(filteredProperties);
  } catch (error) {
    next(error);
  }
};

export const showAvailablePropertiesWithoutFilters: RequestHandler = async (req, res, next) => {
  try {
    const properties = await PropertyModel.find({ isAvailable: true }).exec();
    if (!properties || properties.length === 0) {
      throw createHttpError(404, "No properties found");
    }

    const propertiesWithMedia = await Promise.all(
      properties.map(async (property) => {

        const media = await PropertyMediaModel.find({
          property: property._id,
        }).exec();

        return { ...property.toObject(), media };
      })
    );

    res.status(200).json(propertiesWithMedia);
  } catch (error) {
    next(error);
  }
}

export const showPropertiesAndCandidatesByLandlordId: RequestHandler = async (req, res, next) => {
  try {
    const { landlordId } = req.params;
    if (!landlordId) {
      throw createHttpError(400, "Landlord ID is required");
    }

    /**
    const properties = await PropertyModel.aggregate()
      .match({ landlordAuthID: landlordId, isAvailable: true })
      .project({ createdAt: 0, updatedAt: 0, __v: 0 })
      .lookup({ from: "propertymedias", localField: "_id", foreignField: "property", as: "propertyMedia" }) // Se usa el nombre de la colección en la base de datos
      .addFields({
        // Eliminar campos no deseados de cada propertyMedia
        propertyMedia: {
          $map: {
            input: "$propertyMedia",
            as: "media",
            in: {
              mediaUrl: "$$media.mediaUrl",
              mediaType: "$$media.mediaType",
              description: "$$media.description",
              uploadDate: "$$media.uploadDate",
            },
          },
        },
      })
      .sort({ createdAt: -1 })
      .exec();
      */
    const properties = await PropertyModel
      .aggregate()
      .match({ landlordAuthID: landlordId, isAvailable: true })
      // Buscar medios asociados a la propiedad
      .lookup({
        from: "propertymedias",
        let: { propertyId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$property", "$$propertyId"] } } },
          { $sort: { uploadDate: -1 } },
          { $limit: 1 }
        ],
        as: "propertyMedia"
      })
      // Buscar aplicaciones asociadas a la propiedad
      .lookup({
        from: "applications",
        let: { propertyId: "$_id" },
        pipeline: [
          { $match: { 
            $expr: { $eq: ["$property", "$$propertyId"] }, 
            status: {$ne: 2} 
          } 
        },
          {
            $lookup: {
              from: "tenants",
              let: { tenantAuthID: "$tenantAuthID" }, 
              pipeline: [
                { $match: { $expr: { $eq: ["$authID", "$$tenantAuthID"] } } },
                {
                  $project: {
                    createdAt: 0,
                    updatedAt: 0,
                    __v: 0,
                  }
                }
              ],
              as: "tenantInfo"
            }
          },
          { $unwind: "$tenantInfo" },
          { $sort: { score: -1 } }
        ],
        as: "applications"
      })
      // Proyectar solo los campos necesarioss
      .project({
        _id: 1,
        media: {
          $first: "$propertyMedia.mediaUrl"
        },
        direccion: "$address",
        habitaciones: "$rooms",
        area_propiedad: "$squareMeters",
        total_postulaciones: { $size: "$applications" },
        precio: "$rentPrice",
        bathrooms: "$bathrooms",
        lista_candidatos: {
          $slice: ["$applications", 3]
        }
      })
      .exec();

    if (!properties || properties.length === 0) {
      throw createHttpError(404, "No properties found for landlord");
    }

    res.status(200).json(properties);
  } catch (error) {
    next(error);
  }
};